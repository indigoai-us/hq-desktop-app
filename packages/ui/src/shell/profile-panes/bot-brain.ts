import type { SessionProviderId } from '@hq/platform';
import { LOCAL_BOT_SETTINGS, modelChoicesFor } from '../../chat/local-bot-settings.js';
export type BrainProvider = SessionProviderId;
export const BRAIN_PROVIDERS = [
  { id: 'codex', name: 'OpenAI', subtitle: 'Codex', domain: 'openai.com' },
  { id: 'claude', name: 'Claude', subtitle: 'Anthropic', domain: 'anthropic.com' },
  { id: 'grok', name: 'Grok', subtitle: 'xAI', domain: 'x.ai' },
] as const;
export interface BrainRow {
  id: BrainProvider; name: string; subtitle: string; domain: string;
  state: 'connected' | 'disconnected' | 'unknown'; active: boolean;
  model: string; effort: string; canConnect: boolean; canSave: boolean;
  detail: string; models: { value: string; label: string }[]; efforts: string[];
}
export function providerId(value: string | null | undefined): BrainProvider | null {
  const id = value?.toLowerCase();
  return id === 'openai' || id === 'codex' ? 'codex' : id === 'anthropic' || id === 'claude' ? 'claude' : id === 'grok' || id === 'xai' || id === 'x.ai' ? 'grok' : null;
}
export function brainRow(id: BrainProvider, model = ''): BrainRow {
  return { ...BRAIN_PROVIDERS.find(provider => provider.id === id)!, state: 'unknown', active: false, model, effort: '', canConnect: false, canSave: false, detail: 'Connection status is unavailable.', models: modelChoicesFor({ runtime: id, model }), efforts: LOCAL_BOT_SETTINGS[id].efforts };
}
export function loginState(value: unknown): BrainRow['state'] {
  return value === 'authorized' || value === 'connected' || value === 'authenticated' || value === 'signed-in' ? 'connected' : value === 'disconnected' || value === 'not-connected' || value === 'signed-out' || value === 'expired' ? 'disconnected' : 'unknown';
}
