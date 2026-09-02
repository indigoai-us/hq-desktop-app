import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  SHARE_VAULT_ONLY_HINT,
  deployCommandFor,
  tauriArtifactActions,
} from './session-artifacts';

describe('deployCommandFor', () => {
  it('sends the path bare when it needs no quoting', () => {
    expect(deployCommandFor('/hq/companies/indigo/site/index.html')).toBe(
      '/deploy /hq/companies/indigo/site/index.html',
    );
  });

  it('quotes a path with whitespace or quotes, escaping what it must', () => {
    expect(deployCommandFor('/hq/companies/indigo/Q3 report.md')).toBe(
      '/deploy "/hq/companies/indigo/Q3 report.md"',
    );
    expect(deployCommandFor('/hq/a "b".md')).toBe('/deploy "/hq/a \\"b\\".md"');
  });

  it('never throws on a path that is not a string', () => {
    expect(deployCommandFor(null)).toBe('/deploy ');
    expect(deployCommandFor(undefined)).toBe('/deploy ');
    // An object is read as its JSON, which carries quotes, so it is quoted.
    expect(deployCommandFor({ path: '/x' })).toBe('/deploy "{\\"path\\":\\"/x\\"}"');
  });
});

describe('tauriArtifactActions', () => {
  beforeEach(() => invoke.mockReset());

  it('maps each action onto its backend command with the path as the only argument', async () => {
    invoke.mockResolvedValue({ exists: true });
    const deploy = vi.fn();
    const actions = tauriArtifactActions(deploy);

    await actions.stat('/hq/a.md');
    await actions.open('/hq/a.md');
    await actions.share('/hq/companies/indigo/a.md');
    actions.deploy('/hq/a.md');

    expect(invoke.mock.calls).toEqual([
      ['session_artifact_stat', { path: '/hq/a.md' }],
      ['session_artifact_open', { path: '/hq/a.md' }],
      ['session_artifact_share', { path: '/hq/companies/indigo/a.md' }],
    ]);
    expect(deploy).toHaveBeenCalledWith('/hq/a.md');
  });

  it('names the vault-only rule the way the tooltip says it', () => {
    expect(SHARE_VAULT_ONLY_HINT).toBe('Only company vault files can be shared');
  });
});
