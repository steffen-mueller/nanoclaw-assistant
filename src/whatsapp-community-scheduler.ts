/**
 * WhatsApp community digest scheduler.
 *
 * Fires a digest trigger into the main group's chat at 18:00 local time daily.
 * After injecting the trigger, clears all community buffers so the next cycle
 * starts fresh.
 *
 * On-demand digests (triggered by Steffen asking Kim directly) do NOT clear
 * the buffer — that is handled purely by Kim reading the files.
 */
import { CronExpressionParser } from 'cron-parser';

import { CALENDAR_TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { OnInboundMessage } from './types.js';
import { RegisteredGroup } from './types.js';
import {
  clearAllCommunityBuffers,
  listPendingCommunities,
  loadCommunityGroups,
} from './whatsapp-community.js';

const DIGEST_CRON = '0 18 * * *'; // 18:00 local time every day
const CHECK_INTERVAL_MS = 60_000; // check every minute

function getNextDigestTime(): Date {
  const interval = CronExpressionParser.parse(DIGEST_CRON, {
    tz: CALENDAR_TIMEZONE,
  });
  return interval.next().toDate();
}

export function startCommunityDigestScheduler(
  onMessage: OnInboundMessage,
  getRegisteredGroups: () => Record<string, RegisteredGroup>,
): void {
  let nextDigest = getNextDigestTime();
  logger.info(
    { nextDigest: nextDigest.toISOString() },
    'Community digest scheduler started',
  );

  const check = () => {
    try {
      if (new Date() >= nextDigest) {
        fireDigest(onMessage, getRegisteredGroups);
        nextDigest = getNextDigestTime();
        logger.info(
          { nextDigest: nextDigest.toISOString() },
          'Next community digest scheduled',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Community digest scheduler error');
    }
    setTimeout(check, CHECK_INTERVAL_MS);
  };

  setTimeout(check, CHECK_INTERVAL_MS);
}

function fireDigest(
  onMessage: OnInboundMessage,
  getRegisteredGroups: () => Record<string, RegisteredGroup>,
): void {
  const registeredGroups = getRegisteredGroups();
  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (!mainEntry) {
    logger.warn('No main group found, skipping community digest');
    return;
  }
  const [mainJid, mainGroup] = mainEntry;
  const mainFolder = mainGroup.folder;

  const configured = loadCommunityGroups(mainFolder);
  if (configured.length === 0) return; // no community groups configured

  const pending = listPendingCommunities(mainFolder);
  if (pending.length === 0) {
    logger.debug('No pending community messages, skipping digest');
    return;
  }

  const timestamp = new Date().toISOString();
  const communityList = pending.join(', ');
  const trigger =
    `[WhatsApp Community Digest] New messages are waiting in ` +
    `/workspace/group/whatsapp-community/ for: ${communityList}. ` +
    `Please read each community file, summarize the key topics and highlights ` +
    `per community, and send me a digest. Keep it concise — one section per community.`;

  logger.info({ communities: pending, mainJid }, 'Firing community digest trigger');

  onMessage(mainJid, {
    id: `community-digest-${Date.now()}`,
    chat_jid: mainJid,
    sender: 'community-digest',
    sender_name: 'Community Digest',
    content: trigger,
    timestamp,
    is_from_me: false,
  });

  // Clear buffers after injecting the trigger (not after Kim responds)
  clearAllCommunityBuffers(mainFolder);
  logger.info({ communities: pending }, 'Community buffers cleared after digest trigger');
}
