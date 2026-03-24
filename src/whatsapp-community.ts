/**
 * WhatsApp community group buffering.
 *
 * Loads community group config from the main group folder, buffers incoming
 * messages per community, and provides helpers to read and clear the buffer.
 * Messages are written to:
 *   groups/{mainFolder}/whatsapp-community/{community}.json
 *
 * Each file is a JSON array of CommunityMessage entries, sorted oldest-first.
 * Files are cleared after the scheduled 18:00 digest; on-demand reads do NOT
 * clear the buffer.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export interface CommunityGroupEntry {
  jid: string;
  name: string;
  community: string;
}

export interface CommunityMessage {
  group: string; // human-readable group name
  sender: string; // pushName or phone number
  content: string;
  timestamp: string; // ISO 8601
}

function communityDir(mainFolder: string): string {
  return path.join(GROUPS_DIR, mainFolder, 'whatsapp-community');
}

function communityFile(mainFolder: string, community: string): string {
  const safe = community.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(communityDir(mainFolder), `${safe}.json`);
}

function configPath(mainFolder: string): string {
  return path.join(GROUPS_DIR, mainFolder, 'whatsapp-community-groups.json');
}

/** Load community group config. Returns [] if file missing or unreadable. */
export function loadCommunityGroups(mainFolder: string): CommunityGroupEntry[] {
  try {
    const p = configPath(mainFolder);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as CommunityGroupEntry[];
  } catch {
    return [];
  }
}

/** Build a JID → CommunityGroupEntry lookup map. */
export function buildCommunityIndex(
  entries: CommunityGroupEntry[],
): Map<string, CommunityGroupEntry> {
  return new Map(entries.map((e) => [e.jid, e]));
}

/** Append a message to the community buffer file. */
export function bufferCommunityMessage(
  mainFolder: string,
  entry: CommunityGroupEntry,
  message: CommunityMessage,
): void {
  const dir = communityDir(mainFolder);
  fs.mkdirSync(dir, { recursive: true });
  const file = communityFile(mainFolder, entry.community);
  let messages: CommunityMessage[] = [];
  try {
    if (fs.existsSync(file)) {
      messages = JSON.parse(
        fs.readFileSync(file, 'utf-8'),
      ) as CommunityMessage[];
    }
  } catch {
    /* start fresh */
  }
  messages.push(message);
  fs.writeFileSync(file, JSON.stringify(messages, null, 2));
}

/** List all communities that have buffered messages. */
export function listPendingCommunities(mainFolder: string): string[] {
  const dir = communityDir(mainFolder);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((community) => {
      try {
        const msgs = JSON.parse(
          fs.readFileSync(communityFile(mainFolder, community), 'utf-8'),
        ) as CommunityMessage[];
        return msgs.length > 0;
      } catch {
        return false;
      }
    });
}

/** Clear a community's buffer (called after scheduled digest). */
export function clearCommunityBuffer(
  mainFolder: string,
  community: string,
): void {
  const file = communityFile(mainFolder, community);
  try {
    fs.writeFileSync(file, '[]');
  } catch (err) {
    logger.warn({ community, err }, 'Failed to clear community buffer');
  }
}

/** Clear all community buffers (called after scheduled digest). */
export function clearAllCommunityBuffers(mainFolder: string): void {
  const communities = listPendingCommunities(mainFolder);
  for (const community of communities) {
    clearCommunityBuffer(mainFolder, community);
  }
}
