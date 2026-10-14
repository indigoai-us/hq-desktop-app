import { describe, expect, it, vi } from 'vitest';
import {
  CLT_CARD_COPY,
  CLT_GATED_STAGES,
  commandLineToolsMissing,
  nextCommandLineToolsPhase,
  runCommandLineToolsGate,
  type CommandLineToolsPhase,
  type CommandLineToolsStatus,
} from './command-line-tools-gate';

const missing: CommandLineToolsStatus = {
  required: true,
  present: false,
  installerOpen: false,
  simulated: false,
};
const open: CommandLineToolsStatus = { ...missing, installerOpen: true };
const ready: CommandLineToolsStatus = { ...missing, present: true };

describe('nextCommandLineToolsPhase', () => {
  it('is ready when the tools are present or not required', () => {
    expect(nextCommandLineToolsPhase({ status: ready, installerSeen: true, elapsedMs: 0 }).phase).toBe('ready');
    expect(
      nextCommandLineToolsPhase({
        status: { ...missing, required: false },
        installerSeen: false,
        elapsedMs: 0,
      }).phase,
    ).toBe('ready');
  });

  it('stays installing while Apple’s installer is open and remembers it was seen', () => {
    const r = nextCommandLineToolsPhase({ status: open, installerSeen: false, elapsedMs: 60_000 });
    expect(r).toEqual({ phase: 'installing', installerSeen: true });
  });

  it('waits a grace period for the installer to appear', () => {
    expect(
      nextCommandLineToolsPhase({ status: missing, installerSeen: false, elapsedMs: 5_000, appearGraceMs: 20_000 })
        .phase,
    ).toBe('installing');
    expect(
      nextCommandLineToolsPhase({ status: missing, installerSeen: false, elapsedMs: 20_000, appearGraceMs: 20_000 })
        .phase,
    ).toBe('cancelled');
  });

  it('is cancelled when the installer closes with the tools still missing (Cancel or Disagree)', () => {
    expect(nextCommandLineToolsPhase({ status: missing, installerSeen: true, elapsedMs: 1_000 }).phase).toBe(
      'cancelled',
    );
  });

  it('times out', () => {
    expect(
      nextCommandLineToolsPhase({ status: open, installerSeen: true, elapsedMs: 100, timeoutMs: 100 }).phase,
    ).toBe('timeout');
  });

  it('never cancels in the fake-missing harness, only times out or turns ready', () => {
    const sim = { ...missing, simulated: true };
    expect(nextCommandLineToolsPhase({ status: sim, installerSeen: false, elapsedMs: 10 * 60_000 }).phase).toBe(
      'installing',
    );
  });
});

function harness(statuses: (CommandLineToolsStatus | Error)[], startStatus: CommandLineToolsStatus | Error = open) {
  let clock = 0;
  const phases: CommandLineToolsPhase[] = [];
  const calls: string[] = [];
  const queue = [...statuses];
  const invoke = vi.fn(async (command: string) => {
    calls.push(command);
    if (command === 'command_line_tools_start_install') {
      if (startStatus instanceof Error) throw startStatus;
      return startStatus;
    }
    if (command === 'command_line_tools_show_installer') return true;
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const deps = {
    invoke: invoke as never,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    onPhase: (phase: CommandLineToolsPhase) => {
      phases.push(phase);
      calls.push(`phase:${phase}`);
    },
    isActive: () => true,
    pollMs: 1_000,
    timeoutMs: 60_000,
    appearGraceMs: 5_000,
  };
  return { deps, phases, calls };
}

describe('runCommandLineToolsGate', () => {
  it('puts the card up before it asks macOS to install, then resumes when the tools land', async () => {
    const h = harness([open, open, ready]);
    await expect(runCommandLineToolsGate(h.deps)).resolves.toBe('ready');
    expect(h.calls.indexOf('phase:installing')).toBeLessThan(h.calls.indexOf('command_line_tools_start_install'));
    expect(h.phases).toEqual(['installing', 'ready']);
  });

  it('brings Apple’s installer to the front on each tick while it is open', async () => {
    const h = harness([open, open, ready]);
    await runCommandLineToolsGate(h.deps);
    const fronts = h.calls.filter((c) => c === 'command_line_tools_show_installer').length;
    expect(fronts).toBe(3); // after start, and two open polls
  });

  it('reports cancelled when the installer closes without the tools', async () => {
    const h = harness([missing]);
    await expect(runCommandLineToolsGate(h.deps)).resolves.toBe('cancelled');
    expect(h.phases).toEqual(['installing', 'cancelled']);
  });

  it('reports timeout when the install never finishes', async () => {
    const h = harness([open]);
    await expect(runCommandLineToolsGate(h.deps)).resolves.toBe('timeout');
    expect(h.phases.at(-1)).toBe('timeout');
  });

  it('keeps waiting through bridge errors and times out rather than throwing', async () => {
    const h = harness([new Error('ipc down')], new Error('ipc down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCommandLineToolsGate(h.deps)).resolves.toBe('timeout');
  });

  it('stops when the setup run goes away', async () => {
    const h = harness([open]);
    let active = true;
    h.deps.isActive = () => active;
    h.deps.sleep = async () => {
      active = false;
    };
    await expect(runCommandLineToolsGate(h.deps)).resolves.toBe('inactive');
  });
});

describe('commandLineToolsMissing', () => {
  it('is true only when the tools are required and absent', async () => {
    await expect(commandLineToolsMissing({ invoke: (async () => missing) as never })).resolves.toBe(true);
    await expect(commandLineToolsMissing({ invoke: (async () => ready) as never })).resolves.toBe(false);
    await expect(
      commandLineToolsMissing({ invoke: (async () => ({ ...missing, required: false })) as never }),
    ).resolves.toBe(false);
  });

  it('does not block setup on hosts without the command', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      commandLineToolsMissing({
        invoke: (async () => {
          throw new Error('unknown command');
        }) as never,
      }),
    ).resolves.toBe(false);
    await expect(commandLineToolsMissing({ invoke: (async () => undefined) as never })).resolves.toBe(false);
  });
});

describe('copy', () => {
  it('uses plain language with no raw error text', () => {
    expect(CLT_CARD_COPY.title).toBe("Installing Apple's developer tools");
    expect(CLT_CARD_COPY.body).toMatch(/Install/);
    expect(CLT_CARD_COPY.body).toMatch(/Agree/);
    expect(CLT_CARD_COPY.duration).toMatch(/5 to 15 minutes/);
    expect(CLT_CARD_COPY.resume).toMatch(/continues on its own/);
    expect(CLT_CARD_COPY.showWindow).toBe('Show the Apple window');
  });

  it('gates every stage that runs git but not the template download', () => {
    expect(CLT_GATED_STAGES).toContain('git-init');
    expect(CLT_GATED_STAGES).toContain('deps');
    expect(CLT_GATED_STAGES as readonly string[]).not.toContain('content');
  });
});
