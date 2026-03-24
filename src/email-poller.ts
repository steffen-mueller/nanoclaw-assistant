/**
 * Email poller: fetches new Office 365 messages every 15 minutes,
 * filters against whitelist, and injects emails into the main group
 * as messages for Kim to process.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import Holidays from 'date-holidays';

import {
  CALENDAR_HOLIDAYS_LOCALE,
  CALENDAR_LOOKAHEAD_DAYS,
  CALENDAR_TIMEZONE,
  GROUPS_DIR,
} from './config.js';
import {
  isConfigured,
  listNewMessages,
  markRead,
  archiveMessage,
  getThreadMessages,
  getRecentSenderMessages,
  listEvents,
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
    '\n\n<email_thread_history>\n' +
    parts.join('\n\n') +
    '\n</email_thread_history>'
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

  // Refresh calendar events for all mailboxes
  await refreshCalendarEvents(mailboxes, targetFolder);
}

function toLocalDateTime(utcStr: string, tz: string): string {
  const date = new Date(utcStr.endsWith('Z') ? utcStr : utcStr + 'Z');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function formatAttendee(a: {
  emailAddress: { address: string; name?: string };
}): string {
  const name = a.emailAddress.name;
  const addr = a.emailAddress.address;
  return name ? `${name} <${addr}>` : addr;
}

interface CalendarEventRecord {
  id: string;
  mailbox: string;
  subject: string;
  start: string;
  end: string;
  status?: string;
  body?: string;
  location?: string;
  attendeesAccepted?: string[];
  attendeesNoResponse?: string[];
  attendeesDeclined?: string[];
}

async function refreshCalendarEvents(
  mailboxes: string[],
  targetFolder: string,
): Promise<void> {
  if (mailboxes.length === 0) return;

  const now = new Date();
  const end = new Date(
    now.getTime() + CALENDAR_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
  );
  const start = now.toISOString();
  const endStr = end.toISOString();

  const allEvents: CalendarEventRecord[] = [];
  for (const mailbox of mailboxes) {
    try {
      const events = await listEvents(mailbox, start, endStr);
      for (const event of events) {
        const record: CalendarEventRecord = {
          id: event.id ?? '',
          mailbox,
          subject: event.subject,
          start: toLocalDateTime(event.start.dateTime, CALENDAR_TIMEZONE),
          end: toLocalDateTime(event.end.dateTime, CALENDAR_TIMEZONE),
        };

        if (event.showAs && event.showAs !== 'busy')
          record.status = event.showAs;

        const bodyText = event.body?.content
          ? stripHtml(event.body.content).trim()
          : '';
        if (bodyText) record.body = bodyText;

        const locationName = event.location?.displayName?.trim();
        if (locationName) record.location = locationName;

        if (event.attendees?.length) {
          const accepted: string[] = [];
          const noResponse: string[] = [];
          const declined: string[] = [];
          for (const a of event.attendees) {
            const formatted = formatAttendee(a);
            const response = a.status?.response ?? 'notResponded';
            if (response === 'accepted' || response === 'organizer') {
              accepted.push(formatted);
            } else if (response === 'declined') {
              declined.push(formatted);
            } else {
              noResponse.push(formatted);
            }
          }
          if (accepted.length) record.attendeesAccepted = accepted;
          if (noResponse.length) record.attendeesNoResponse = noResponse;
          if (declined.length) record.attendeesDeclined = declined;
        }

        allEvents.push(record);
      }
    } catch (err) {
      logger.error({ mailbox, err }, 'Calendar refresh failed for mailbox');
    }
  }

  // Inject public holidays as synthetic events
  const [country, state, region] = CALENDAR_HOLIDAYS_LOCALE.split('.');
  const hd = new Holidays(country, state, region);
  const years = new Set([now.getFullYear(), end.getFullYear()]);
  for (const year of years) {
    for (const holiday of hd.getHolidays(year)) {
      if (holiday.type !== 'public') continue;
      const holidayDate = new Date(holiday.start);
      if (holidayDate < now || holidayDate > end) continue;
      const dateStr = holiday.date.slice(0, 10); // "YYYY-MM-DD"
      allEvents.push({
        id: `holiday-${dateStr}-${holiday.rule}`,
        mailbox: '',
        subject: holiday.name,
        start: `${dateStr}T00:00`,
        end: `${dateStr}T23:59`,
        status: 'holiday',
      });
    }
  }

  // Sort all events (real + holidays) by start time
  allEvents.sort((a, b) => a.start.localeCompare(b.start));

  const resultFile = path.join(
    GROUPS_DIR,
    targetFolder,
    'calendar-events.json',
  );
  try {
    fs.writeFileSync(
      resultFile,
      JSON.stringify(
        { updatedAt: now.toISOString(), events: allEvents },
        null,
        2,
      ),
    );
    logger.debug(
      { count: allEvents.length, lookaheadDays: CALENDAR_LOOKAHEAD_DAYS },
      'Calendar events refreshed',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to write calendar-events.json');
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
