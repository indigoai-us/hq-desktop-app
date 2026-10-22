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
  defaultModel: string; modelEfforts: Record<string, string[]>;
}
export interface CatalogModel { id: string; label: string; authModes: string[]; efforts: string[]; selectable: boolean; visibility: string; isNew?: boolean }
export type ModelCatalog = Partial<Record<BrainProvider, { defaultModel: string; models: CatalogModel[] }>>;
export type BrainChoices = Pick<BrainRow, 'models' | 'efforts' | 'defaultModel' | 'modelEfforts'>;
const CLOUD_FALLBACK_EXCLUDED = new Set(['gpt-5.5']);
export function providerId(value: string | null | undefined): BrainProvider | null {
  const id = value?.toLowerCase();
  return id === 'openai' || id === 'codex' ? 'codex' : id === 'anthropic' || id === 'claude' ? 'claude' : id === 'grok' || id === 'xai' || id === 'x.ai' ? 'grok' : null;
}
export function brainRow(id: BrainProvider, model = ''): BrainRow {
  return { ...BRAIN_PROVIDERS.find(provider => provider.id === id)!, state: 'unknown', active: false, model, effort: '', canConnect: false, canSave: false, detail: 'Connection status is unavailable.', models: modelChoicesFor({ runtime: id, model }), efforts: LOCAL_BOT_SETTINGS[id].efforts, defaultModel: '', modelEfforts: {} };
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
export function modelCatalog(value: unknown): ModelCatalog | null {
  const providers = value && typeof value === 'object' ? (value as { providers?: unknown }).providers : null;
  if (!providers || typeof providers !== 'object') return null;
  const catalog: ModelCatalog = {};
  for (const { id } of BRAIN_PROVIDERS) {
    const view = (providers as Record<string, unknown>)[id] as { defaultModel?: unknown; models?: unknown } | undefined;
    if (!view || typeof view.defaultModel !== 'string' || !Array.isArray(view.models)) continue;
    catalog[id] = { defaultModel: view.defaultModel, models: view.models.filter((m): m is CatalogModel => !!m && typeof m === 'object' && typeof m.id === 'string' && typeof m.label === 'string' && strings(m.authModes) && strings(m.efforts) && typeof m.selectable === 'boolean' && typeof m.visibility === 'string') };
  }
  return Object.keys(catalog).length ? catalog : null;
}
export function cloudBrainChoices(id: BrainProvider, catalog: ModelCatalog | null, current = ''): BrainChoices {
  const offered = catalog?.[id]?.models.filter(m => m.selectable && m.visibility === 'shown' && m.authModes.includes('subscription')) ?? [];
  if (!offered.length) {
    const models = modelChoicesFor({ runtime: id, model: current }).filter(choice => choice.value !== '' && !CLOUD_FALLBACK_EXCLUDED.has(choice.value));
    return { models, efforts: LOCAL_BOT_SETTINGS[id].efforts, defaultModel: LOCAL_BOT_SETTINGS[id].models.find(choice => !CLOUD_FALLBACK_EXCLUDED.has(choice.value))?.value ?? '', modelEfforts: {} };
  }
  const fallback = offered.find(m => m.id === catalog?.[id]?.defaultModel) ?? offered[0];
  return { models: offered.map(m => ({ value: m.id, label: m.label })), efforts: fallback.efforts, defaultModel: fallback.id, modelEfforts: Object.fromEntries(offered.map(m => [m.id, m.efforts])) };
}
export function effortsFor(row: Pick<BrainRow, 'efforts' | 'modelEfforts'>, model: string): string[] {
  return row.modelEfforts[model] ?? row.efforts;
}
export function loginState(value: unknown): BrainRow['state'] {
  return value === 'authorized' || value === 'connected' || value === 'authenticated' || value === 'signed-in' ? 'connected' : value === 'disconnected' || value === 'not-connected' || value === 'signed-out' || value === 'expired' ? 'disconnected' : 'unknown';
}
