/**
 * Audit switches for the preview harness (AUDIT-3). Preview only: nothing in
 * this file is imported by the app entry, so it never reaches the bundle.
 *
 *   ?auth=signed-out|expired|invalid|non-human   boot onto the signed-out page
 *   ?reads=slow|fail|empty|partial               data reads (boot commands pass)
 *       slow     resolve after ?loadingMs (default 2500) to watch skeleton → content
 *       fail     every data read rejects
 *       empty    every list in every result is empty
 *       partial  every second data command (stable by name) rejects, the rest load
 *       hang     every data read never settles (BLANK-1)
 *       denied   every data read is refused the way a 403 comes back (BLANK-1):
 *                host commands reject with a 403 message, hq-pro reads answer 403
 *   ?toast=update|info|error|progress|stack       raise toasts through the real paths
 *   ?gates=on                                    flag registry answers true for every key
 *   ?atlas=populated                             company Atlas reads a synced folder
 *   ?newbot=priced|included                      New bot opens its cloud takeover: every
 *       company has cloud bots, and the plan check answers with a price
 *       (priced) or as included in the company's plan (included)
 *   ?plan=slow                                   with ?newbot=, the plan check answers
 *       after ?loadingMs (default 2500), to see "Checking plan..."
 *
 * Combine freely with ?persona=, ?theme= and ?route=.
 */
import { isBootCommand } from './state-flags';

function params(search?: string | null): URLSearchParams {
  const raw = search ?? (typeof window === 'undefined' ? '' : window.location.search);
  return new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
}

export const AUTH_SWITCHES = {
  'signed-out': 'credentials_absent',
  expired: 'credentials_invalid',
  invalid: 'credentials_invalid',
  'non-human': 'non_human_principal',
} as const;

export function authSwitch(search?: string | null): string | null {
  const value = params(search).get('auth') as keyof typeof AUTH_SWITCHES | null;
  return value && value in AUTH_SWITCHES ? AUTH_SWITCHES[value] : null;
}

export type ReadsSwitch = 'slow' | 'fail' | 'empty' | 'partial' | 'hang' | 'denied';

const READS_SWITCHES: readonly ReadsSwitch[] = ['slow', 'fail', 'empty', 'partial', 'hang', 'denied'];

export function readsSwitch(search?: string | null): ReadsSwitch | null {
  const value = params(search).get('reads') as ReadsSwitch | null;
  return value && READS_SWITCHES.includes(value) ? value : null;
}

/** Stable split for `reads=partial`: about half of all command names fail. */
export function failsInPartial(cmd: string): boolean {
  if (isBootCommand(cmd)) return false;
  let hash = 0;
  for (let i = 0; i < cmd.length; i += 1) hash = (hash * 31 + cmd.charCodeAt(i)) >>> 0;
  return hash % 2 === 0;
}

export function gatesOn(search?: string | null): boolean {
  return params(search).get('gates') === 'on';
}

export type NewBotSwitch = 'priced' | 'included';

export function newBotSwitch(search?: string | null): NewBotSwitch | null {
  const value = params(search).get('newbot');
  return value === 'priced' || value === 'included' ? value : null;
}

/** The plan check New bot makes for a company, as the server answers it. */
function newBotProvisionOptions(kind: NewBotSwitch): unknown {
  const included = kind === 'included';
  const option = (key: string, productName: string, instanceType: string, cents: number, isDefault: boolean) => ({
    key,
    productName,
    instanceType,
    listCents: cents,
    default: isDefault,
    selectable: true,
    netMonthlyCents: included && isDefault ? 0 : cents,
    deltaCents: null,
    unavailableReason: null,
    notBilled: included && isDefault,
    lanes: isDefault ? 1 : 2,
    workers: isDefault ? 1 : 2,
  });
  return {
    defaultInstanceType: 't4g.medium',
    catalogVersion: 'harness',
    options: [option('basic', 'Basic', 't4g.medium', 5000, true), option('power', 'Power', 't4g.large', 9000, false)],
  };
}

export function atlasPopulated(search?: string | null): boolean {
  return params(search).get('atlas') === 'populated';
}

export function toastSwitch(search?: string | null): string | null {
  return params(search).get('toast');
}

const STAMP = '2026-10-01T12:00:00.000Z';
const ATLAS_DISTRICTS: Record<string, string[]> = {
  projects: ['hq-desktop-app', 'console-rail', 'hq-sync-browse-vs-sync', 'event-driven-sync', 'meetings-v2', 'onboarding-flow'],
  knowledge: ['guides', 'brand', 'customers', 'engineering'],
  policies: ['no-secrets', 'american-spelling', 'design-standard'],
  workers: ['scout', 'frontend-dev', 'qa-tester'],
  skills: ['triage', 'standup-brief', 'deploy'],
};

function atlasObjects(full: boolean): Array<{ key: string; lastModified: string; size: number }> {
  const out: Array<{ key: string; lastModified: string; size: number }> = [];
  for (const [district, names] of Object.entries(ATLAS_DISTRICTS)) {
    for (const name of names) {
      if (district === 'projects') {
        out.push(full
          ? { key: `projects/${name}/prd.json`, lastModified: STAMP, size: 40 }
          : { key: `projects/${name}/`, lastModified: STAMP, size: 0 });
        if (full) out.push({ key: `projects/${name}/README.md`, lastModified: STAMP, size: 4 });
      } else if (district === 'policies') {
        out.push({ key: `policies/${name}.md`, lastModified: STAMP, size: 10 });
      } else if (district === 'workers') {
        out.push({ key: `workers/${name}/worker.yaml`, lastModified: STAMP, size: 10 });
      } else if (district === 'skills') {
        out.push({ key: `skills/${name}/SKILL.md`, lastModified: STAMP, size: 10 });
      } else {
        out.push(full
          ? { key: `knowledge/${name}/index.md`, lastModified: STAMP, size: 4 }
          : { key: `knowledge/${name}/`, lastModified: STAMP, size: 0 });
      }
    }
  }
  return out;
}

/**
 * Handlers layered over the normal mock when a switch is on. Returns
 * `undefined` when no switch claims the command.
 */
export function switchedHandler(
  cmd: string,
  args: Record<string, unknown> | undefined,
  search?: string | null,
): { value: unknown } | undefined {
  const auth = authSwitch(search);
  if (auth) {
    if (cmd === 'get_auth_session') {
      return { value: { accountId: null, generation: 1, status: auth, reason: null } };
    }
    if (cmd === 'get_auth_state') return { value: { authenticated: false } };
  }
  const newBot = newBotSwitch(search);
  if (newBot && cmd === 'hq_pro_fetch') {
    const url = typeof args?.url === 'string' ? args.url : '';
    if (url.startsWith('/v1/flags/resolve?companyUid=')) {
      const flags = { 'agents.desktop-agent-creation': true };
      return { value: { status: 200, body: JSON.stringify({ version: 1, flags }) } };
    }
    if (url.startsWith('/v1/agents/provision-options')) {
      const answer = { status: 200, body: JSON.stringify(newBotProvisionOptions(newBot)) };
      if (params(search).get('plan') !== 'slow') return { value: answer };
      const ms = Number(params(search).get('loadingMs')) || 2500;
      return { value: new Promise((resolve) => setTimeout(() => resolve(answer), ms)) };
    }
  }
  if (gatesOn(search) && cmd === 'hq_pro_fetch') {
    const url = typeof args?.url === 'string' ? args.url : '';
    if (url.startsWith('/v1/flags/resolve')) {
      const flags: Record<string, boolean> = {
        'desktop.rail-telemetry-v1': true,
        'desktop.rail-outpost-v1': true,
        'desktop.rail-atlas-v1': true,
        'desktop.rail-deployments-actions-v1': true,
        'desktop.rail-shortcut-editing-v1': true,
        'desktop.rail-workforce-limits-v1': true,
      };
      return { value: { status: 200, body: JSON.stringify({ version: 1, flags }) } };
    }
    if (url.startsWith('/v1/identity/features/')) {
      return { value: { status: 200, body: 'true' } };
    }
  }
  if (atlasPopulated(search)) {
    if (cmd === 'atlas_local_first_page') {
      return { value: { revision: 'r1', complete: false, objects: atlasObjects(false) } };
    }
    if (cmd === 'atlas_local_listing') {
      return { value: { revision: 'r1', complete: true, objects: atlasObjects(true) } };
    }
    if (cmd === 'atlas_local_read_text') {
      const key = String(args?.key ?? '');
      const match = key.match(/^projects\/([^/]+)\/prd\.json$/);
      return {
        value: match
          ? JSON.stringify({ name: match[1], metadata: { repoPath: `repos/private/${match[1]}` }, userStories: [] })
          : null,
      };
    }
  }
  return undefined;
}

/** Apply `reads=` around the normal handler. */
export async function withReadsSwitch<T>(
  reads: ReadsSwitch | null,
  cmd: string,
  run: () => Promise<T>,
  loadingMs: number | null,
): Promise<T> {
  if (!reads || isBootCommand(cmd)) return run();
  if (reads === 'hang') return new Promise<T>(() => {});
  if (reads === 'denied') {
    if (cmd === 'hq_pro_fetch') {
      return { status: 403, body: JSON.stringify({ error: 'forbidden', message: 'Forbidden' }) } as T;
    }
    throw new Error(`hq-pro returned 403 Forbidden for ${cmd}`);
  }
  if (reads === 'partial') {
    if (failsInPartial(cmd)) throw new Error(`harness: simulated failure for ${cmd}`);
    return run();
  }
  if (reads === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, loadingMs ?? 2500));
  }
  return run();
}

type Emit = (event: string, payload?: unknown) => Promise<void> | void;
type Push = (input: { title: string; detail: string; tone: 'ok' | 'err' | 'neutral' }) => unknown;

/**
 * Raise the toasts named by `?toast=` through the paths the product uses:
 * update and progress go through the shell's own event listeners; info and
 * error replay copy the product pushes (QA-077, MeetingCanvasHost).
 */
export function raiseToasts(kind: string | null, emit: Emit, push: Push): void {
  if (!kind) return;
  const kinds = kind === 'stack' ? ['update', 'progress', 'info', 'error'] : kind.split(',');
  for (const k of kinds) {
    if (k === 'update') {
      void emit('update-gate://deferred', { pendingVersion: '0.3.0-beta.3', reasons: [] });
    } else if (k === 'progress') {
      void emit('sync:plan', { company: 'indigo', filesToDownload: 12, filesToUpload: 4, filesToDelete: 0 });
      for (let i = 0; i < 6; i += 1) void emit('sync:progress', { company: 'indigo' });
    } else if (k === 'info') {
      push({ title: 'Open a company first', detail: '', tone: 'neutral' });
    } else if (k === 'error') {
      push({ title: 'Could not copy the link', detail: 'https://hq.computer/m/abc123', tone: 'err' });
    }
  }
}
