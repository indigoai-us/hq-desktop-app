/** Server-owned conversation time, separate from an office's transport call. */
export interface Conversation {
  conversationId: string;
  state: 'active' | 'paused' | 'finalized';
  startedAt: number;
  activeSince: number | null;
  pausedAt: number | null;
  elapsedMs: number;
  endedAt: number | null;
}
export function parseConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== 'object') return null;
  const v=value as Record<string,unknown>;
  if(typeof v.conversationId!=='string'||v.conversationId.length>200 || !v.conversationId || !['active','paused','finalized'].includes(String(v.state))) return null;
  for(const k of ['startedAt','elapsedMs']) if(typeof v[k]!=='number'||!Number.isFinite(v[k])||Number(v[k])<0) return null;
  for(const k of ['activeSince','pausedAt','endedAt']) if(v[k]!==null && (typeof v[k]!=='number'||!Number.isFinite(v[k])||Number(v[k])<0)) return null;
  return v as unknown as Conversation;
}
export function conversationElapsed(value: Conversation | null, serverNow: number): number {
  if(!value) return 0;
  return value.elapsedMs+(value.state==='active'&&value.activeSince!==null ? Math.max(0,serverNow-value.activeSince) : 0);
}
export function formatConversationTime(ms: number): string {
  const seconds=Math.floor(Math.max(0,ms)/1000);
  return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
}
