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

import { TauriPlatformAdapter } from './index.js';
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
      kickoff: 'Kickoff: check where this HQ stands, then start the first unfinished step.',
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
          kickoff: 'Kickoff: check where this HQ stands, then start the first unfinished step.',
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
      kickoff: null,
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
      kickoff: 'Start on the inbox.',
      memory: 'synced',
    } as const;

    await adapter.bots!.create({ ...input });

    for (const key of Object.keys(input)) {
      expect(calls[0]!.args).toHaveProperty(key, input[key as keyof typeof input]);
    }
  });
});

// The Tauri adapter (TauriPlatformAdapter) carries its own copy of the mapping;
// hold it to the same contract so the two cannot drift apart again.
describe('tauri adapter local bots create', () => {
  function tauriWithRecorder() {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { ok: true };
      },
    });
    return { adapter, calls };
  }

  it('passes the kickoff (and every other create setting) through to local_bots_create', async () => {
    const { adapter, calls } = tauriWithRecorder();
    await adapter.bots!.create({
      name: 'setup',
      runtime: 'claude',
      worker: 'setup',
      intro: 'Hi.',
      kickoff: 'Kickoff: start step one.',
      memory: 'synced',
    });
    expect(calls).toEqual([
      {
        cmd: 'local_bots_create',
        args: {
          name: 'setup',
          runtime: 'claude',
          model: null,
          autoApprove: null,
          worker: 'setup',
          intro: 'Hi.',
          kickoff: 'Kickoff: start step one.',
          memory: 'synced',
        },
      },
    ]);
  });

  it('sends kickoff: null when none was given', async () => {
    const { adapter, calls } = tauriWithRecorder();
    await adapter.bots!.create({ name: 'scout', runtime: 'grok' });
    expect(calls[0]!.args).toHaveProperty('kickoff', null);
  });

  it('maps exactly the same keys as the sync adapter', async () => {
    const tauri = tauriWithRecorder();
    const sync = adapterWithRecorder();
    const input = { name: 'iris', runtime: 'codex', kickoff: 'Go.' } as const;
    await tauri.adapter.bots!.create({ ...input });
    await sync.adapter.bots!.create({ ...input });
    expect(Object.keys(tauri.calls[0]!.args!).sort()).toEqual(Object.keys(sync.calls[0]!.args!).sort());
  });
});
