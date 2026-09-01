import { describe, expect, it, vi } from 'vitest';
import {
  checkAllUpdates,
  summarizeResults,
  type TargetResult,
  type UpdateTarget,
} from '../../src/lib/update-check';

const COMMANDS = {
  app: 'check_for_updates',
  core: 'check_core_state',
  cli: 'check_hq_cli_update',
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function invokeFromMap(responses: Record<string, unknown>) {
  return vi.fn(async (cmd: string) => {
    if (!(cmd in responses)) throw new Error(`unexpected command: ${cmd}`);
    const value = responses[cmd];
    if (value instanceof Error) throw value;
    return value;
  });
}

describe('checkAllUpdates', () => {
  it('invokes all three commands once each with the correct names', async () => {
    const invoke = invokeFromMap({
      [COMMANDS.app]: null,
      [COMMANDS.core]: { updateAvailable: false },
      [COMMANDS.cli]: null,
    });

    await checkAllUpdates({ invoke });

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenCalledWith('check_for_updates');
    expect(invoke).toHaveBeenCalledWith('check_core_state');
    expect(invoke).toHaveBeenCalledWith('check_hq_cli_update');
  });

  it('reports up-to-date across the board when every target is current', async () => {
    const invoke = invokeFromMap({
      [COMMANDS.app]: null,
      [COMMANDS.core]: { updateAvailable: false },
      [COMMANDS.cli]: null,
    });

    const results = await checkAllUpdates({ invoke });

    expect(results.map((r) => r.status)).toEqual([
      'up-to-date',
      'up-to-date',
      'up-to-date',
    ]);
    expect(summarizeResults(results)).toBe('up-to-date');
  });

  it('marks the app target update-available when UpdateInfo is returned', async () => {
    const info = { version: '0.10.171' };
    const invoke = invokeFromMap({
      [COMMANDS.app]: info,
      [COMMANDS.core]: { updateAvailable: false },
      [COMMANDS.cli]: null,
    });

    const results = await checkAllUpdates({ invoke });
    const app = results.find((r) => r.target === 'app');

    expect(app).toEqual({
      target: 'app',
      status: 'update-available',
      detail: info,
    });
    expect(summarizeResults(results)).toBe('update-available');
  });

  it('handles a core updateAvailable flag and a CLI version pair', async () => {
    const coreState = {
      updateAvailable: true,
      latestVersion: '12.1.0',
      driftReport: { count: 2 },
    };
    const cliInfo = { local: '1.2.3', latest: '1.3.0' };
    const invoke = invokeFromMap({
      [COMMANDS.app]: null,
      [COMMANDS.core]: coreState,
      [COMMANDS.cli]: cliInfo,
    });

    const results = await checkAllUpdates({ invoke });
    const byTarget = Object.fromEntries(results.map((r) => [r.target, r]));

    expect(byTarget.core).toEqual({
      target: 'core',
      status: 'update-available',
      detail: coreState,
    });
    expect(byTarget.cli).toEqual({
      target: 'cli',
      status: 'update-available',
      detail: cliInfo,
    });
    expect(byTarget.app.status).toBe('up-to-date');
    expect(summarizeResults(results)).toBe('update-available');
  });

  it('isolates a rejecting target without sinking the others', async () => {
    const info = { version: '0.10.171' };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === COMMANDS.app) return info;
      if (cmd === COMMANDS.core) return { updateAvailable: false };
      if (cmd === COMMANDS.cli) throw new Error('cli registry unreachable');
      throw new Error(`unexpected command: ${cmd}`);
    });

    const results = await checkAllUpdates({ invoke });
    const byTarget = Object.fromEntries(results.map((r) => [r.target, r]));

    expect(byTarget.app).toEqual({
      target: 'app',
      status: 'update-available',
      detail: info,
    });
    expect(byTarget.core.status).toBe('up-to-date');
    expect(byTarget.cli).toEqual({
      target: 'cli',
      status: 'error',
      error: 'cli registry unreachable',
    });
    // update-available takes precedence over error.
    expect(summarizeResults(results)).toBe('update-available');
  });

  it('calls onTargetStart for every target and onTargetDone with each result', async () => {
    const invoke = invokeFromMap({
      [COMMANDS.app]: null,
      [COMMANDS.core]: { updateAvailable: false },
      [COMMANDS.cli]: null,
    });
    const onTargetStart = vi.fn();
    const onTargetDone = vi.fn();

    const results = await checkAllUpdates(
      { invoke },
      { onTargetStart, onTargetDone },
    );

    expect(onTargetStart).toHaveBeenCalledTimes(3);
    expect(onTargetStart).toHaveBeenCalledWith('app');
    expect(onTargetStart).toHaveBeenCalledWith('core');
    expect(onTargetStart).toHaveBeenCalledWith('cli');

    expect(onTargetDone).toHaveBeenCalledTimes(3);
    const doneResults = onTargetDone.mock.calls.map(([r]) => r as TargetResult);
    expect(doneResults).toEqual(expect.arrayContaining(results));
    expect(doneResults).toHaveLength(results.length);
  });

  it('returns results in stable [app, core, cli] order regardless of settle order', async () => {
    const app = deferred<null>();
    const core = deferred<{ updateAvailable: boolean }>();
    const cli = deferred<{ local: string; latest: string }>();
    const invoke = vi.fn((cmd: string) => {
      if (cmd === COMMANDS.app) return app.promise;
      if (cmd === COMMANDS.core) return core.promise;
      if (cmd === COMMANDS.cli) return cli.promise;
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    const started: UpdateTarget[] = [];
    const settled: UpdateTarget[] = [];
    const pending = checkAllUpdates(
      { invoke },
      {
        onTargetStart: (t) => started.push(t),
        onTargetDone: (r) => settled.push(r.target),
      },
    );

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(started).toEqual(['app', 'core', 'cli']);

    cli.resolve({ local: '1.2.3', latest: '1.3.0' });
    await vi.waitFor(() => expect(settled).toEqual(['cli']));

    app.resolve(null);
    await vi.waitFor(() => expect(settled).toEqual(['cli', 'app']));

    core.resolve({ updateAvailable: false });
    const results = await pending;

    expect(settled).toEqual(['cli', 'app', 'core']);
    expect(results.map((r) => r.target)).toEqual(['app', 'core', 'cli']);
  });
});

describe('summarizeResults', () => {
  it('returns error when a target failed and none have an update', () => {
    expect(
      summarizeResults([
        { target: 'app', status: 'up-to-date' },
        { target: 'core', status: 'error', error: 'timeout' },
        { target: 'cli', status: 'up-to-date' },
      ]),
    ).toBe('error');
  });
});
