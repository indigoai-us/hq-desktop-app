// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { openAgentWorkflow } from './agent-workflow';

describe('openAgentWorkflow', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.writeText.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
  });

  it('reports a deep-link handoff as opened', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ hqFolderPath: '/tmp/hq' })
      .mockResolvedValueOnce(undefined);

    await expect(openAgentWorkflow('/deploy', 'deploy workflow')).resolves.toMatchObject({
      outcome: 'opened',
      ok: true,
    });
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it('reports a successful clipboard fallback as copied, not failed', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ hqFolderPath: '/tmp/hq' })
      .mockRejectedValueOnce(new Error('not installed'));
    mocks.writeText.mockResolvedValue(undefined);

    await expect(openAgentWorkflow('/deploy', 'deploy workflow')).resolves.toMatchObject({
      outcome: 'copied',
      ok: false,
    });
    expect(mocks.writeText).toHaveBeenCalledWith('/deploy');
  });

  it('reports failure only when neither handoff path works', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ hqFolderPath: '/tmp/hq' })
      .mockRejectedValueOnce(new Error('not installed'));
    mocks.writeText.mockRejectedValueOnce(new Error('clipboard denied'));

    await expect(openAgentWorkflow('/deploy', 'deploy workflow')).resolves.toMatchObject({
      outcome: 'failed',
      ok: false,
    });
  });
});
