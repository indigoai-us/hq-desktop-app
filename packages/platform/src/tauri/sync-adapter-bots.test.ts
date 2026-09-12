/**
 * The Work shell runs on createSyncPlatformAdapter, so this is the adapter that
 * decides which of the New bot form's answers reach `hq bot create`. On
 * 2026-09-12 it forwarded only name/runtime/model/autoApprove/worker, so the
 * written welcome (`intro`) and the memory choice were dropped between the form
 * and Rust, and the new setup bot opened with the generic default hello.
 *
 * These tests assert the behaviour (the arguments handed to invoke), not the
 * source text, so the mapping cannot silently lose a field again.
 */
import { describe, expect, it } from 'vitest';

import { createSyncPlatformAdapter } from './sync-adapter.js';

function adapterWithRecorder() {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return { ok: true };
    },
    fetch: (() => {
      throw new Error('the adapter must not use window.fetch');
    }) as unknown as typeof globalThis.fetch,
  });
  return { adapter, calls };
}

describe('sync adapter local bots create', () => {
  it('passes the intro and memory choice through to local_bots_create', async () => {
    const { adapter, calls } = adapterWithRecorder();

    await adapter.bots!.create({
      name: 'setup',
      runtime: 'claude',
      worker: 'setup',
      intro: "Hi, I'm setup. I'll walk you through getting HQ ready.",
      memory: 'local',
      model: 'opus',
      autoApprove: true,
    });

    expect(calls).toEqual([
      {
        cmd: 'local_bots_create',
        args: {
          name: 'setup',
          runtime: 'claude',
          model: 'opus',
          autoApprove: true,
          worker: 'setup',
          intro: "Hi, I'm setup. I'll walk you through getting HQ ready.",
          memory: 'local',
        },
      },
    ]);
  });

  it('sends null, not undefined, for the settings the form left blank', async () => {
    const { adapter, calls } = adapterWithRecorder();

    await adapter.bots!.create({ name: 'scout', runtime: 'grok' });

    expect(calls[0]!.args).toEqual({
      name: 'scout',
      runtime: 'grok',
      model: null,
      autoApprove: null,
      worker: null,
      intro: null,
      memory: null,
    });
  });

  it('forwards every key of the create input it is given', async () => {
    const { adapter, calls } = adapterWithRecorder();
    const input = {
      name: 'iris',
      runtime: 'claude',
      model: 'sonnet',
      autoApprove: false,
      worker: 'iris-cx',
      intro: 'Hello.',
      memory: 'synced',
    } as const;

    await adapter.bots!.create({ ...input });

    for (const key of Object.keys(input)) {
      expect(calls[0]!.args).toHaveProperty(key, input[key as keyof typeof input]);
    }
  });
});
