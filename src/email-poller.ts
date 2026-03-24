/**
 * Email poller: fetches new Office 365 messages every 15 minutes,
 * filters against whitelist, and injects emails into the main group
 * as messages for Kim to process.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { GROUPS_DIR } from './config.js';
import {
  isConfigured,
  listNewMessages,
  markRead,
  archiveMessage,
  getThreadMessages,
  getRecentSenderMessages,
  GraphMessage,
} from './msgraph.js';
import { OnInboundMessage } from './types.js';

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

interface EmailWhitelist {
  contacts: string[]; // exact addresses or @domain.com patterns
  newsletters: string[];
}

function whitelistPath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'email-whitelist.json');
}

function loadWhitelist(groupFolder: string): EmailWhitelist {
  try {
    const p = whitelistPath(groupFolder);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as EmailWhitelist;
    }
  } catch {
    /* ignore */
  }
  return { contacts: [], newsletters: [] };
}

function isNewsletter(from: string, whitelist: EmailWhitelist): boolean {
  const addr = from.toLowerCase();
  for (const entry of whitelist.newsletters) {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith('@')) {
      if (addr.endsWith(pattern)) return true;
    } else {
      if (addr === pattern) return true;
    }
  }
  return false;
}

function getConfiguredMailboxes(): string[] {
  const env = readEnvFile(['OFFICE365_MAILBOXES']);
  const raw = process.env.OFFICE365_MAILBOXES || env.OFFICE365_MAILBOXES || '';
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatEmail(mailbox: string, msg: GraphMessage): string {
  const from = msg.from?.emailAddress
    ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`
    : '(unknown sender)';
  const date = new Date(msg.receivedDateTime).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  let body =
    msg.body.contentType === 'html'
      ? stripHtml(msg.body.content)
      : msg.body.content;

  // Truncate long bodies
  if (body.length > 3000) {
    body = body.slice(0, 3000) + '\n[...truncated]';
  }

  // Email body is wrapped in XML tags to structurally isolate untrusted content
  // from instructions. Anything inside <email_body> is data, not a command.
  return [
    `[New Email — ${mailbox}]`,
    `From: ${from}`,
    `Subject: ${msg.subject || '(no subject)'}`,
    `Date: ${date}`,
    `message_id: ${msg.id}`,
    '',
    '<email_body>',
    body,
    '</email_body>',
  ].join('\n');
}

const CONTEXT_BODY_LIMIT = 2048;
const CONTEXT_MAX_MESSAGES = 5;

function formatEmailContext(messages: GraphMessage[]): string {
  if (messages.length === 0) return '';
  const parts = messages.map((msg) => {
    const from = msg.from?.emailAddress
      ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`
      : '(unknown)';
    const date = new Date(msg.receivedDateTime).toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    let body =
      msg.body.contentType === 'html'
        ? stripHtml(msg.body.content)
        : msg.body.content;
    if (body.length > CONTEXT_BODY_LIMIT) {
      body = body.slice(0, CONTEXT_BODY_LIMIT) + '\n[...truncated]';
    }
    return `--- ${date} | From: ${from} | Subject: ${msg.subject || '(no subject)'} ---\n${body}`;
  });
  return (
    '\n\n<email_thread_history>\n' + parts.join('\n\n') + '\n</email_thread_history>'
  );
}

function appendToNewsletterQueue(groupFolder: string, entry: object): void {
  const queueFile = path.join(
    GROUPS_DIR,
    groupFolder,
    'email-newsletter-queue.json',
  );
  let queue: object[] = [];
  try {
    if (fs.existsSync(queueFile)) {
      queue = JSON.parse(fs.readFileSync(queueFile, 'utf-8')) as object[];
    }
  } catch {
    /* ignore */
  }
  queue.push(entry);
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
}

async function poll(
  onMessage: OnInboundMessage,
  targetJid: string,
  targetFolder: string,
): Promise<void> {
  const mailboxes = getConfiguredMailboxes();
  if (mailboxes.length === 0) return;

  const whitelist = loadWhitelist(targetFolder);
  let totalDelivered = 0;
  let totalWhitelisted = 0;

  for (const mailbox of mailboxes) {
    try {
      const messages = await listNewMessages(mailbox);
      for (const msg of messages) {
        const fromAddr = msg.from?.emailAddress?.address || '';
        if (!fromAddr) continue;
        if (isNewsletter(fromAddr, whitelist)) {
          appendToNewsletterQueue(targetFolder, {
            mailbox,
            from: fromAddr,
            fromName: msg.from?.emailAddress?.name || fromAddr,
            subject: msg.subject,
            receivedAt: msg.receivedDateTime,
            message_id: msg.id,
          });
          totalWhitelisted++;
          await markRead(mailbox, msg.id);
          await archiveMessage(mailbox, msg.id);
        } else {
          let contextBlock = '';
          try {
            let contextMessages = await getThreadMessages(
              mailbox,
              msg.conversationId,
              msg.id,
              CONTEXT_MAX_MESSAGES,
            );
            if (contextMessages.length === 0) {
              contextMessages = await getRecentSenderMessages(
                mailbox,
                fromAddr,
                msg.id,
                CONTEXT_MAX_MESSAGES,
              );
            }
            contextBlock = formatEmailContext(contextMessages);
          } catch (err) {
            logger.warn(
              { mailbox, messageId: msg.id, err },
              'Failed to fetch email context',
            );
          }
          const content = formatEmail(mailbox, msg) + contextBlock;
          const timestamp = new Date().toISOString();
          onMessage(targetJid, {
            id: `email-${msg.id}`,
            chat_jid: targetJid,
            sender: 'email-poller',
            sender_name: `Email (${mailbox})`,
            content,
            timestamp,
            is_from_me: false,
          });
          totalDelivered++;
        }
      }
    } catch (err) {
      logger.error({ mailbox, err }, 'Email poll failed for mailbox');
    }
  }

  if (totalDelivered > 0 || totalWhitelisted > 0) {
    logger.info(
      { delivered: totalDelivered, whitelisted: totalWhitelisted },
      'Email poll complete',
    );
  }
}

export function startEmailPoller(
  onMessage: OnInboundMessage,
  targetJid: string,
  targetFolder: string,
): void {
  if (!isConfigured()) {
    logger.info('Office 365 not configured, email poller not started');
    return;
  }

  logger.info(
    { targetJid, mailboxes: getConfiguredMailboxes() },
    'Email poller started',
  );

  // Run immediately, then on interval
  poll(onMessage, targetJid, targetFolder).catch((err) =>
    logger.error({ err }, 'Initial email poll failed'),
  );
  setInterval(() => {
    poll(onMessage, targetJid, targetFolder).catch((err) =>
      logger.error({ err }, 'Email poll failed'),
    );
  }, POLL_INTERVAL_MS);
}
