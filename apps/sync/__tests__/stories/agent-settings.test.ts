import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolvePendingDesktopRoute,
  SETTINGS_SECTIONS,
} from '../../src/desktop-alt/route';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const source = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

describe('Settings > Agents', () => {
  it('is a routed first-class Settings section', () => {
    expect(SETTINGS_SECTIONS).toContainEqual({
      id: 'agents',
      label: 'Agents',
    });
    expect(resolvePendingDesktopRoute('settings:agents')).toEqual({
      kind: 'settings',
      tab: 'agents',
    });
  });

  it('documents in-app install, connect, models, and honest usage', () => {
    const page = source('src/desktop-alt/pages/SettingsPage.svelte');
    const panel = source('src/desktop-alt/components/AgentProvidersSettings.svelte');
    expect(page).toContain('AgentProvidersSettings');
    expect(panel).toContain('data-testid="settings-agents"');
    expect(panel).toContain('installProvider');
    expect(panel).toContain('Connect');
    expect(panel).toContain('Models:');
    expect(panel).toContain('Usage stays with this provider');
  });
});
