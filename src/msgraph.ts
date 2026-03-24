/**
 * Microsoft Graph API client for Office 365 mail and calendar.
 * Handles token refresh and all Graph API calls.
 */
import fs from 'fs';
import https from 'https';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL_BASE = 'https://login.microsoftonline.com';
const DELTA_FILE = path.join(STORE_DIR, 'email-delta.json');

interface TokenCache {
  accessToken: string;
  expiresAt: number; // Unix ms
}

let tokenCache: TokenCache | null = null;

function getCredentials() {
  const env = readEnvFile([
    'OFFICE365_CLIENT_ID',
    'OFFICE365_CLIENT_SECRET',
    'OFFICE365_TENANT_ID',
    'OFFICE365_REFRESH_TOKEN',
  ]);
  return {
    clientId: process.env.OFFICE365_CLIENT_ID || env.OFFICE365_CLIENT_ID || '',
    clientSecret:
      process.env.OFFICE365_CLIENT_SECRET || env.OFFICE365_CLIENT_SECRET || '',
    tenantId: process.env.OFFICE365_TENANT_ID || env.OFFICE365_TENANT_ID || '',
    refreshToken:
      process.env.OFFICE365_REFRESH_TOKEN || env.OFFICE365_REFRESH_TOKEN || '',
  };
}

export function isConfigured(): boolean {
  const c = getCredentials();
  return !!(c.clientId && c.clientSecret && c.tenantId && c.refreshToken);
}

async function httpPost(
  url: string,
  body: string,
  contentType = 'application/x-www-form-urlencoded',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function graphRequest(
  method: string,
  endpoint: string,
  body?: object,
  accessToken?: string,
): Promise<{ status: number; data: unknown }> {
  const token = accessToken || (await refreshAccessToken());
  return new Promise((resolve, reject) => {
    const url = new URL(
      endpoint.startsWith('https://') ? endpoint : `${GRAPH_BASE}${endpoint}`,
    );
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode || 0,
              data: data ? JSON.parse(data) : null,
            });
          } catch {
            resolve({ status: res.statusCode || 0, data });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export async function refreshAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.accessToken;
  }

  const creds = getCredentials();
  // App is registered as a public client (Allow public client flows = Yes).
  // Public clients must NOT include client_secret in token refresh requests.
  const body = new URLSearchParams({
    client_id: creds.clientId,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://graph.microsoft.com/.default',
  }).toString();

  const response = await httpPost(
    `${TOKEN_URL_BASE}/${creds.tenantId}/oauth2/v2.0/token`,
    body,
  );
  const json = JSON.parse(response) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!json.access_token) {
    throw new Error(
      `Token refresh failed: ${json.error} — ${json.error_description}`,
    );
  }

  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
  logger.debug('Graph API access token refreshed');
  return tokenCache.accessToken;
}

// ─── Delta token persistence ──────────────────────────────────────────────

function loadDeltaTokens(): Record<string, string> {
  try {
    if (fs.existsSync(DELTA_FILE)) {
      return JSON.parse(fs.readFileSync(DELTA_FILE, 'utf-8')) as Record<
        string,
        string
      >;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function saveDeltaTokens(tokens: Record<string, string>): void {
  fs.mkdirSync(path.dirname(DELTA_FILE), { recursive: true });
  fs.writeFileSync(DELTA_FILE, JSON.stringify(tokens, null, 2));
}

// ─── Mail ─────────────────────────────────────────────────────────────────

export interface GraphMessage {
  id: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  body: { content: string; contentType: string };
  isRead: boolean;
  conversationId: string;
}

/**
 * Fetch new messages using delta query for efficient incremental sync.
 * Returns messages received since the last call (per mailbox).
 */
export async function listNewMessages(
  mailbox: string,
): Promise<GraphMessage[]> {
  const deltaTokens = loadDeltaTokens();
  const deltaKey = `mail:${mailbox}`;

  // Use saved delta link or start fresh
  const startUrl = deltaTokens[deltaKey]
    ? deltaTokens[deltaKey]
    : `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta?$select=id,subject,from,toRecipients,receivedDateTime,body,isRead,conversationId&$top=20`;

  const messages: GraphMessage[] = [];
  let nextUrl: string | null = startUrl;
  let newDeltaToken: string | null = null;

  while (nextUrl) {
    const res = await graphRequest('GET', nextUrl);
    const data = res.data as {
      value?: GraphMessage[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };

    if (res.status === 410) {
      // Delta token expired — reset
      logger.warn({ mailbox }, 'Delta token expired, resetting sync');
      delete deltaTokens[deltaKey];
      saveDeltaTokens(deltaTokens);
      return listNewMessages(mailbox);
    }

    if (res.status !== 200) {
      logger.error(
        { mailbox, status: res.status, data: res.data },
        'Graph listNewMessages failed',
      );
      break;
    }

    if (data.value) {
      messages.push(...data.value.filter((m) => !m.isRead));
    }

    if (data['@odata.deltaLink']) {
      newDeltaToken = data['@odata.deltaLink'];
      nextUrl = null;
    } else {
      nextUrl = data['@odata.nextLink'] || null;
    }
  }

  if (newDeltaToken) {
    deltaTokens[deltaKey] = newDeltaToken;
    saveDeltaTokens(deltaTokens);
  }

  logger.info({ mailbox, count: messages.length }, 'Fetched new messages');
  return messages;
}

export async function createDraft(
  mailbox: string,
  to: string,
  subject: string,
  body: string,
  replyToMessageId?: string,
): Promise<string | null> {
  let endpoint: string;
  let payload: object;

  if (replyToMessageId) {
    endpoint = `/users/${encodeURIComponent(mailbox)}/messages/${replyToMessageId}/createReply`;
    const res = await graphRequest('POST', endpoint, {});
    const draft = res.data as {
      id?: string;
      body?: { content: string; contentType: string };
    };
    if (!draft.id) {
      logger.error(
        { mailbox, replyToMessageId, status: res.status },
        'createReply failed',
      );
      return null;
    }
    // Inject Kim's reply HTML at the top of the existing draft body, which
    // already contains Outlook's default signature and the quoted original.
    const existing = draft.body?.content || '';
    const combined = existing.match(/<body[^>]*>/i)
      ? existing.replace(/<body[^>]*>/i, (tag) => tag + body + '<br><br>')
      : body + '<br><br>' + existing;
    const updateRes = await graphRequest(
      'PATCH',
      `/users/${encodeURIComponent(mailbox)}/messages/${draft.id}`,
      { body: { contentType: 'HTML', content: combined } },
    );
    if (updateRes.status !== 200) {
      logger.error({ mailbox, draftId: draft.id }, 'Draft body update failed');
    }
    logger.info(
      { mailbox, draftId: draft.id },
      'Reply draft created in Outlook',
    );
    return draft.id;
  }

  // Create the draft with no body first so Outlook can inject the default
  // signature, then inject Kim's content at the top of the resulting body.
  const newRes = await graphRequest(
    'POST',
    `/users/${encodeURIComponent(mailbox)}/messages`,
    {
      subject,
      toRecipients: [{ emailAddress: { address: to } }],
      isDraft: true,
    },
  );
  const newDraft = newRes.data as {
    id?: string;
    body?: { content: string; contentType: string };
  };
  if (!newDraft.id) {
    logger.error({ mailbox, status: newRes.status }, 'createDraft failed');
    return null;
  }
  const existing = newDraft.body?.content || '';
  const combined = existing.match(/<body[^>]*>/i)
    ? existing.replace(/<body[^>]*>/i, (tag) => tag + body + '<br><br>')
    : body + (existing ? '<br><br>' + existing : '');
  const updateRes = await graphRequest(
    'PATCH',
    `/users/${encodeURIComponent(mailbox)}/messages/${newDraft.id}`,
    { body: { contentType: 'HTML', content: combined } },
  );
  if (updateRes.status !== 200) {
    logger.error(
      { mailbox, draftId: newDraft.id },
      'New draft body update failed',
    );
  }
  logger.info({ mailbox, draftId: newDraft.id }, 'Draft created in Outlook');
  return newDraft.id;
}

export async function moveToJunk(
  mailbox: string,
  messageId: string,
): Promise<void> {
  const res = await graphRequest(
    'POST',
    `/users/${encodeURIComponent(mailbox)}/messages/${messageId}/move`,
    { destinationId: 'junkemail' },
  );
  if (res.status !== 201) {
    logger.error(
      { mailbox, messageId, status: res.status },
      'moveToJunk failed',
    );
  }
}

export async function archiveMessage(
  mailbox: string,
  messageId: string,
): Promise<void> {
  const res = await graphRequest(
    'POST',
    `/users/${encodeURIComponent(mailbox)}/messages/${messageId}/move`,
    { destinationId: 'archive' },
  );
  if (res.status !== 201) {
    logger.error(
      { mailbox, messageId, status: res.status },
      'archiveMessage failed',
    );
  }
}

export async function markRead(
  mailbox: string,
  messageId: string,
): Promise<void> {
  await graphRequest(
    'PATCH',
    `/users/${encodeURIComponent(mailbox)}/messages/${messageId}`,
    { isRead: true },
  );
}

/**
 * Fetch previous messages in the same conversation thread, ordered newest first.
 * Excludes the current message. Returns at most `limit` results.
 */
export async function getThreadMessages(
  mailbox: string,
  conversationId: string,
  currentMessageId: string,
  limit = 5,
): Promise<GraphMessage[]> {
  const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
  const select =
    'id,subject,from,toRecipients,receivedDateTime,body,isRead,conversationId';
  const endpoint = `/users/${encodeURIComponent(mailbox)}/messages?$filter=${filter}&$select=${select}&$orderby=receivedDateTime%20desc&$top=${limit + 1}`;
  const res = await graphRequest('GET', endpoint);
  if (res.status !== 200) {
    logger.warn(
      { mailbox, conversationId, status: res.status },
      'getThreadMessages failed',
    );
    return [];
  }
  const data = res.data as { value?: GraphMessage[] };
  return (data.value || [])
    .filter((m) => m.id !== currentMessageId)
    .slice(0, limit);
}

/**
 * Fetch recent messages from the same sender, ordered newest first.
 * Excludes the current message. Used as fallback when this is the first
 * message in a thread. Returns at most `limit` results.
 */
export async function getRecentSenderMessages(
  mailbox: string,
  senderAddress: string,
  currentMessageId: string,
  limit = 5,
): Promise<GraphMessage[]> {
  const filter = encodeURIComponent(
    `from/emailAddress/address eq '${senderAddress}'`,
  );
  const select =
    'id,subject,from,toRecipients,receivedDateTime,body,isRead,conversationId';
  const endpoint = `/users/${encodeURIComponent(mailbox)}/messages?$filter=${filter}&$select=${select}&$orderby=receivedDateTime%20desc&$top=${limit + 1}`;
  const res = await graphRequest('GET', endpoint);
  if (res.status !== 200) {
    logger.warn(
      { mailbox, senderAddress, status: res.status },
      'getRecentSenderMessages failed',
    );
    return [];
  }
  const data = res.data as { value?: GraphMessage[] };
  return (data.value || [])
    .filter((m) => m.id !== currentMessageId)
    .slice(0, limit);
}

// ─── Calendar ─────────────────────────────────────────────────────────────

export interface GraphEvent {
  id?: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  body?: { contentType: string; content: string };
  attendees?: Array<{
    emailAddress: { address: string; name?: string };
    type: 'required' | 'optional';
    status?: { response: string; time?: string };
  }>;
  showAs?: string;
}

export async function listEvents(
  mailbox: string,
  from: string,
  to: string,
): Promise<GraphEvent[]> {
  const start = encodeURIComponent(from);
  const end = encodeURIComponent(to);
  const res = await graphRequest(
    'GET',
    `/users/${encodeURIComponent(mailbox)}/calendarView?startDateTime=${start}&endDateTime=${end}&$select=id,subject,start,end,location,body,attendees,showAs&$orderby=start/dateTime&$top=50`,
  );
  const data = res.data as { value?: GraphEvent[] };
  if (res.status !== 200) {
    logger.error({ mailbox, status: res.status }, 'listEvents failed');
    return [];
  }
  return data.value || [];
}

export async function createEvent(
  mailbox: string,
  event: GraphEvent,
): Promise<string | null> {
  const res = await graphRequest(
    'POST',
    `/users/${encodeURIComponent(mailbox)}/events`,
    event,
  );
  const created = res.data as { id?: string };
  if (res.status !== 201 || !created.id) {
    logger.error({ mailbox, status: res.status }, 'createEvent failed');
    return null;
  }
  logger.info({ mailbox, eventId: created.id }, 'Calendar event created');
  return created.id;
}

export async function updateEvent(
  mailbox: string,
  eventId: string,
  changes: Partial<GraphEvent>,
): Promise<void> {
  const res = await graphRequest(
    'PATCH',
    `/users/${encodeURIComponent(mailbox)}/events/${eventId}`,
    changes,
  );
  if (res.status !== 200) {
    logger.error(
      { mailbox, eventId, status: res.status },
      'updateEvent failed',
    );
  }
}

export async function deleteEvent(
  mailbox: string,
  eventId: string,
): Promise<void> {
  const res = await graphRequest(
    'DELETE',
    `/users/${encodeURIComponent(mailbox)}/events/${eventId}`,
  );
  if (res.status !== 204) {
    logger.error(
      { mailbox, eventId, status: res.status },
      'deleteEvent failed',
    );
  }
}
