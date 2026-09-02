// @vitest-environment happy-dom
/**
 * The folded tool row, mounted: the artifact action row appears only once the
 * group is expanded, and every action honours what the stat said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import ToolGroupRow from './ToolGroupRow.svelte';
import {
  SHARE_VAULT_ONLY_HINT,
  type ArtifactActions,
  type ArtifactStat,
} from './session-artifacts';
import type { ToolArtifact, ToolCallSummary } from './transcript-adapter';

const CALLS: ToolCallSummary[] = [
  {
    id: 'w1',
    name: 'Write',
    detail: '/hq/companies/indigo/report.md',
    status: 'ok',
    outcome: '',
    output: '',
    artifactPath: '/hq/companies/indigo/report.md',
  },
];

const VAULT: ToolArtifact = { path: '/hq/companies/indigo/report.md', name: 'report.md', kind: 'file' };
const OUTSIDE: ToolArtifact = { path: '/hq/workspace/site/index.html', name: 'index.html', kind: 'file' };
const GONE: ToolArtifact = { path: '/hq/companies/indigo/gone.txt', name: 'gone.txt', kind: 'file' };

const STATS: Record<string, ArtifactStat> = {
  [VAULT.path]: { exists: true, kind: 'file', shareable: true, company: 'indigo', deployable: true },
  [OUTSIDE.path]: { exists: true, kind: 'file', shareable: false, company: null, deployable: true },
  [GONE.path]: { exists: false, kind: 'missing', shareable: false, company: null, deployable: false },
};

function fakeActions(overrides: Partial<ArtifactActions> = {}) {
  const actions: ArtifactActions = {
    stat: vi.fn((path: string) => Promise.resolve(STATS[path]!)),
    open: vi.fn(() => Promise.resolve()),
    share: vi.fn(() =>
      Promise.resolve({ url: 'https://hq.indigo.com/share-session/tok', expiresInMinutes: 15 }),
    ),
    deploy: vi.fn(),
    ...overrides,
  };
  return actions;
}

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown>) {
  component = mount(ToolGroupRow, {
    target: host,
    props: { summary: 'Edited 1 file', calls: CALLS, ...props },
  }) as Record<string, unknown>;
  flushSync();
}

const at = (testid: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${testid}"]`);
const all = (testid: string): HTMLElement[] =>
  Array.from(host.querySelectorAll(`[data-testid="${testid}"]`));
const must = (testid: string): HTMLElement => {
  const found = at(testid);
  if (!found) throw new Error(`missing [data-testid="${testid}"]`);
  return found;
};
const click = (element: HTMLElement) => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  flushSync();
};
/** Let the stat promises land, then flush the DOM. */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
});

describe('ToolGroupRow · artifacts', () => {
  it('shows nothing extra while collapsed and lists the files once expanded', () => {
    render({ artifacts: [VAULT], artifactActions: fakeActions() });
    expect(at('session-tool-artifacts')).toBeNull();
    expect(host.textContent).not.toContain('report.md');
    click(must('session-tool-group-toggle'));
    expect(at('session-tool-artifacts')).not.toBeNull();
    expect(all('session-artifact')).toHaveLength(1);
    expect(must('session-artifact').textContent).toContain('report.md');
    expect(must('session-artifact').textContent).toContain(VAULT.path);
  });

  it('adds a file count to the summary only when the summary does not already say so', () => {
    render({ summary: 'Used 1 tool', artifacts: [VAULT, OUTSIDE], artifactActions: fakeActions() });
    expect(must('session-tool-group-toggle').textContent).toContain('Used 1 tool · 2 files');
    unmount(component!);
    component = null;
    render({ summary: 'Edited 1 file', artifacts: [VAULT], artifactActions: fakeActions() });
    expect(must('session-tool-group-toggle').textContent?.trim()).toBe('Edited 1 file');
  });

  it('enables Open, Share and Deploy for a vault file the stat approves', async () => {
    const actions = fakeActions();
    render({ artifacts: [VAULT], artifactActions: actions });
    click(must('session-tool-group-toggle'));
    // Every action is held back until the stat answers.
    expect((must('session-artifact-open') as HTMLButtonElement).disabled).toBe(true);
    await settle();
    expect(actions.stat).toHaveBeenCalledWith(VAULT.path);
    expect((must('session-artifact-open') as HTMLButtonElement).disabled).toBe(false);
    expect((must('session-artifact-share') as HTMLButtonElement).disabled).toBe(false);
    expect((must('session-artifact-deploy') as HTMLButtonElement).disabled).toBe(false);

    click(must('session-artifact-open'));
    expect(actions.open).toHaveBeenCalledWith(VAULT.path);
    // Open holds the row busy until it resolves; only then may Deploy fire.
    expect((must('session-artifact-deploy') as HTMLButtonElement).disabled).toBe(true);
    await settle();
    click(must('session-artifact-deploy'));
    expect(actions.deploy).toHaveBeenCalledWith(VAULT.path);
  });

  it('disables Share for a file outside the vault and says why', async () => {
    render({ artifacts: [OUTSIDE], artifactActions: fakeActions() });
    click(must('session-tool-group-toggle'));
    await settle();
    const share = must('session-artifact-share') as HTMLButtonElement;
    expect(share.disabled).toBe(true);
    expect(share.title).toBe(SHARE_VAULT_ONLY_HINT);
    expect((must('session-artifact-open') as HTMLButtonElement).disabled).toBe(false);
    expect((must('session-artifact-deploy') as HTMLButtonElement).disabled).toBe(false);
  });

  it('marks a deleted file missing and disables everything', async () => {
    render({ artifacts: [GONE], artifactActions: fakeActions() });
    click(must('session-tool-group-toggle'));
    await settle();
    expect(at('session-artifact-missing')).not.toBeNull();
    expect(must('session-artifact').dataset.missing).toBe('true');
    for (const id of ['session-artifact-open', 'session-artifact-share', 'session-artifact-deploy']) {
      expect((must(id) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('treats a failed stat as missing rather than guessing', async () => {
    render({
      artifacts: [VAULT],
      artifactActions: fakeActions({ stat: vi.fn(() => Promise.reject(new Error('outside root'))) }),
    });
    click(must('session-tool-group-toggle'));
    await settle();
    expect(at('session-artifact-missing')).not.toBeNull();
    expect((must('session-artifact-share') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the minted link once, with Copy, and forgets it on dismiss', async () => {
    const actions = fakeActions();
    render({ artifacts: [VAULT], artifactActions: actions });
    click(must('session-tool-group-toggle'));
    await settle();
    expect(at('session-artifact-share-card')).toBeNull();

    click(must('session-artifact-share'));
    await settle();
    expect(actions.share).toHaveBeenCalledWith(VAULT.path);
    const card = must('session-artifact-share-card');
    expect(card.textContent).toContain('expires in 15 min');
    expect(must('session-artifact-share-url').textContent).toBe(
      'https://hq.indigo.com/share-session/tok',
    );
    expect(at('session-artifact-copy')).not.toBeNull();

    click(must('session-artifact-share-dismiss'));
    expect(at('session-artifact-share-card')).toBeNull();
    expect(host.textContent).not.toContain('share-session/tok');
  });

  it('surfaces a share failure inline without a card', async () => {
    render({
      artifacts: [VAULT],
      artifactActions: fakeActions({
        share: vi.fn(() => Promise.reject(new Error('Not signed in. Run /hq-login first.'))),
      }),
    });
    click(must('session-tool-group-toggle'));
    await settle();
    click(must('session-artifact-share'));
    await settle();
    expect(at('session-artifact-share-card')).toBeNull();
    expect(must('session-artifact-error').textContent).toContain('Not signed in');
  });

  it('lists files without actions when no port is supplied', () => {
    render({ artifacts: [VAULT] });
    click(must('session-tool-group-toggle'));
    expect(all('session-artifact')).toHaveLength(1);
    expect(at('session-artifact-open')).toBeNull();
    expect(at('session-artifact-share')).toBeNull();
  });
});
