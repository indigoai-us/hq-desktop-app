import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REMOVED = ['src/desktop-alt/panels/DeploymentsPanel.svelte', 'src/desktop-alt/panels/SecretsPanel.svelte', 'src/desktop-alt/panels/ActivityPanel.svelte', 'src/desktop-alt/panels/CompanyOperationsPanel.svelte', 'src/desktop-alt/pages/MissionControlPage.svelte', 'src/desktop-alt/panels/LiveSessionsPanel.svelte', 'src/desktop-alt/panels/SessionHistoryPanel.svelte', 'src/desktop-alt/components/DeploymentRow.svelte', 'src/desktop-alt/components/SecretEnvRow.svelte'];

describe('company work actions — ops moved to console (US-021)', () => {
  it('no longer ships the dropped desktop surfaces', () => {
    for (const rel of REMOVED) {
      expect(existsSync(join(process.cwd(), rel)), rel).toBe(false);
    }
  });
});
