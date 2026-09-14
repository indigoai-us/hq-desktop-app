import { invoke } from '@tauri-apps/api/core';
import type { LinkedSession, ProjectLink } from './session-project-links';

export interface SharedProjectSession {
  sessionId: string;
  channelId: string;
  ownerUid: string;
  title: string;
  tool: string;
  createdAt: string;
  nextSequence: number;
  isOwner?: boolean;
}
export interface SharedMessage { sequence: number; role: 'user' | 'assistant'; text: string }
export interface SharedPage {
  session: SharedProjectSession;
  messages: SharedMessage[];
  nextCursor: number | null;
}
export function readSharedSession(channelId: string, sessionId: string, after = 0): Promise<SharedPage> {
  return invoke('project_sessions_read', { channelId, sessionId, after: String(after) });
}

/** Owner sessions already have a local canonical row; never duplicate it with its cloud copy. */
export function sharedRows(rows: SharedProjectSession[]): LinkedSession[] {
  return rows.filter(row => !row.isOwner).map(row => ({
    sessionId: row.sessionId, title: row.title, tool: row.tool, startedAt: row.createdAt,
    phase: 'ended', sharedChannelId: row.channelId,
  }));
}

export async function loadSharedRows(link: ProjectLink): Promise<LinkedSession[]> {
  if (!link.channelId) return [];
  const rows: SharedProjectSession[] = [];
  let after: string | null = null;
  const seen = new Set<string>();
  do {
    const page: { sessions: SharedProjectSession[]; nextCursor: string | null } = await invoke('project_sessions_read', {
      channelId: link.channelId, sessionId: null, after,
    });
    rows.push(...page.sessions);
    after = page.nextCursor;
    if (after && seen.has(after)) throw new Error('Session list returned a repeated page');
    if (after) seen.add(after);
  } while (after);
  return sharedRows(rows);
}
