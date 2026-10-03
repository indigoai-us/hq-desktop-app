import { describe, expect, it, vi } from 'vitest';

import {
  createDesktopStartupDiagnostics,
  DESKTOP_STARTUP_EVENTS,
  formatDesktopStartupDiagnostic,
  MAX_DESKTOP_STARTUP_ELAPSED_MS,
} from './startup-diagnostics';

describe('desktop startup diagnostics', () => {
  it('emits only fixed categories once with bounded monotonic timings', () => {
    let now = 10;
    const calls: Array<{ tag: string; message: string }> = [];
    const diagnostics = createDesktopStartupDiagnostics(async (_command, args) => {
      calls.push(args);
    }, () => now);

    expect(diagnostics.emit('entry-started')).toBe(true);
    expect(diagnostics.emit('entry-started')).toBe(false);
    now = 1_500_020;
    expect(diagnostics.emit('boot-failed')).toBe(true);

    expect(calls).toEqual([
      { tag: 'boot-startup', message: 'event=entry-started elapsed_ms=0' },
      {
        tag: 'boot-startup',
        message: `event=boot-failed elapsed_ms=${MAX_DESKTOP_STARTUP_ELAPSED_MS}`,
      },
    ]);
    expect(DESKTOP_STARTUP_EVENTS).toHaveLength(9);
  });

  it('reports global categories without values and removes its listeners', () => {
    const invoke = vi.fn<Parameters<typeof createDesktopStartupDiagnostics>[0]>(
      async () => undefined,
    );
    const target = new EventTarget();
    const diagnostics = createDesktopStartupDiagnostics(invoke, () => 25);
    const remove = diagnostics.installGlobalErrorListeners(target as never);

    target.dispatchEvent(new Event('error'));
    target.dispatchEvent(new Event('error'));
    target.dispatchEvent(new Event('unhandledrejection'));
    remove();
    target.dispatchEvent(new Event('unhandledrejection'));

    expect(invoke.mock.calls.map(([, args]) => args.message)).toEqual([
      'event=global-error elapsed_ms=0',
      'event=unhandled-rejection elapsed_ms=0',
    ]);
    expect(invoke.mock.calls.flat().join(' ')).not.toMatch(/message|stack|reason|secret/i);
  });

  it('normalizes invalid and negative elapsed values without custom data', () => {
    expect(formatDesktopStartupDiagnostic('mount-completed', Number.NaN)).toBe(
      'event=mount-completed elapsed_ms=0',
    );
    expect(formatDesktopStartupDiagnostic('mount-completed', -12)).toBe(
      'event=mount-completed elapsed_ms=0',
    );
  });
});
