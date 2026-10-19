import { slackFactsFromStatus } from '../../chat/messaging/connection-card-model.js';

export type ChannelState = 'connected' | 'not-connected' | 'pending' | 'error' | 'unknown';
export interface BotChannel {
  id: string;
  name: string;
  domain: string;
  description: string;
  state: ChannelState;
  detail?: string;
  canConnect: boolean;
  canDisconnect?: boolean;
}
export const DEFAULT_CHANNELS = [
  { id: 'slack', name: 'Slack', domain: 'slack.com', description: 'Bring your bot into your team’s workspace.' },
  { id: 'telegram', name: 'Telegram', domain: 'telegram.org', description: 'Talk with your bot in chats and groups.' },
] as const;
export const CHANNEL_STATUS: Record<ChannelState, string> = {
  connected: 'Connected', 'not-connected': 'Not connected', pending: 'Setup in progress', error: 'Needs attention', unknown: 'Status unavailable',
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export function channelRows(status: unknown, profile: unknown, slackAvailable: boolean): BotChannel[] {
  const root = record(profile);
  const box = record(root?.box);
  const platforms = Array.isArray(box?.platforms) ? box.platforms : null;
  const stale = record(root?.boxFreshness)?.source === 'cache' || record(root?.boxFreshness)?.source === 'unavailable';
  const rows: BotChannel[] = DEFAULT_CHANNELS.map(channel => ({ ...channel, state: 'unknown', canConnect: false }));
  if (platforms) for (const raw of platforms) {
    const platform = record(raw);
    if (typeof platform?.name !== 'string') continue;
    const id = platform.name.trim().toLowerCase();
    // WhatsApp has no Fleet connection API yet; suppress stale runtime reports too.
    if (id === 'whatsapp') continue;
    if (!id || rows.some(row => row.id === id && row.state !== 'unknown')) continue;
    const state: ChannelState = platform.state === 'connected' ? 'connected'
      : ['disconnected', 'not-connected', 'not_connected'].includes(String(platform.state)) ? 'not-connected'
      : ['pending', 'connecting'].includes(String(platform.state)) ? 'pending'
      : ['error', 'failed'].includes(String(platform.state)) ? 'error' : 'unknown';
    const row = rows.find(row => row.id === id);
    if (row) row.state = stale ? 'unknown' : state;
    else rows.push({ id, name: platform.name, domain: '', description: 'A channel reported by this bot.', state: stale ? 'unknown' : state, canConnect: false });
  }
  // The Slack card and its connection flow share the same authoritative test.
  if (status !== null) {
    const facts = slackFactsFromStatus(status);
    rows[0].state = facts.state === 'none' ? 'not-connected' : facts.state;
    rows[0].canConnect = slackAvailable;
  }
  for (const row of rows) {
    row.detail = row.id === 'slack' && row.canConnect ? (row.state === 'pending' ? 'Continue the guided setup to finish connecting.' : undefined)
      : row.state === 'connected' ? 'Connection reported by your bot. Configuration is not editable here yet.'
      : 'Connection setup is not available in this desktop build yet.';
    if (stale && row.id !== 'slack') row.detail = 'The bot’s cached status is out of date. Refresh to check again.';
  }
  return rows;
}
