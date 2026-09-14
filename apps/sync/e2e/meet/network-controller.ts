/** Only mutates explicitly labeled links inside an existing disposable Linux namespace. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { profiles, type Profile } from './fixtures';
const exec = promisify(execFile);
export interface NetworkScope { namespace: string; runId: string; deviceId: string; auditPath: string }
export type NetworkCommand = (args: string[]) => Promise<string>;
const nativeCommand: NetworkCommand = async args => {
  if (process.platform !== 'linux') throw new Error('network control requires disposable Linux router host');
  return (await exec('ip', args, { timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' })).stdout;
};
export function shapingArguments(scope: NetworkScope, profile: Profile, iface: 'uplink' | 'guest', action: 'add' | 'change', offline = false): string[] {
  validateScope(scope);
  const p = profiles[profile];
  if (!p) throw new Error('unknown network profile');
  return ['netns','exec',scope.namespace,'tc','qdisc',action,'dev',iface,'root','handle','712:','netem',
    'limit','1000','delay',`${p.rttMs / 2}ms`,`${p.jitterMs}ms`,'loss',`${offline ? 100 : p.lossPercent}%`,
    'rate',`${iface === 'uplink' ? p.uploadMbps : p.downloadMbps}mbit`];
}
function validateScope(s: NetworkScope) {
  if (!/^[a-f0-9]{16}$/.test(s.runId) || s.namespace !== `hq-meet-${s.runId}` ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(s.deviceId) || !isAbsolute(s.auditPath)) throw new Error('invalid disposable namespace scope');
}
export function verifyShaping(text: string, profile: Profile, iface: 'uplink' | 'guest', offline = false): number {
  const p = profiles[profile];
  const loss = Number(/\bloss (\d+(?:\.\d+)?)%/.exec(text)?.[1]);
  const delay = Number(/\bdelay (\d+(?:\.\d+)?)ms/.exec(text)?.[1]);
  const jitter = Number(/\bdelay \d+(?:\.\d+)?ms (\d+(?:\.\d+)?)ms/.exec(text)?.[1] ?? 0);
  const rate = /\brate (\d+(?:\.\d+)?)([KMG]?)bit\b/.exec(text);
  const mbps = rate ? Number(rate[1]) * ({ '': 0.000001, K: 0.001, M: 1, G: 1000 }[rate[2]] ?? NaN) : NaN;
  const sent = Number(/\bSent (\d+) bytes/.exec(text)?.[1]);
  if (!/^qdisc netem 712: root/m.test(text) || loss !== (offline ? 100 : p.lossPercent) || delay !== p.rttMs / 2 ||
      jitter !== p.jitterMs || mbps !== (iface === 'uplink' ? p.uploadMbps : p.downloadMbps) || !Number.isSafeInteger(sent) || sent < 0) throw new Error('network shaping verification mismatch');
  return sent;
}
export async function withNetworkProfile<T>(options: { scope: NetworkScope; profile: Profile; durationMs: number; signal?: AbortSignal },
  operation: (control: { signal: AbortSignal; collectionStarted: () => void }) => Promise<T>, command: NetworkCommand = nativeCommand, wait?: (ms: number, signal: AbortSignal) => Promise<void>): Promise<{ result: T; networkArtifact: { path: string; kind: 'network-shaping'; status: 'verified-and-cleaned'; deviceId: string } }> {
  validateScope(options.scope);
  if (!Number.isInteger(options.durationMs) || options.durationMs < 30000 || options.durationMs > 3600000) throw new Error('invalid bounded network duration');
  const { scope, profile } = options;
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const timeout = setTimeout(() => abort.abort(), options.durationMs + 180000);
  const owned: ('uplink' | 'guest')[] = [];
  let fault: Promise<void> | undefined, faultError: unknown, started = false, start = 0;
  const audit = (row: unknown) => appendFile(scope.auditPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const invoke = async (args: string[]) => {
    await audit({ event: 'command-start', args });
    try { const output = await command(args); await audit({ event: 'command-ok', args }); return output; }
    catch (error) { await audit({ event: 'command-failed', args }); throw error; }
  };
  const show = (iface: string) => invoke(['netns','exec',scope.namespace,'tc','-s','qdisc','show','dev',iface]);
  const delay = (ms: number) => wait ? wait(ms, signal) : new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('network run cancelled'));
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const cancel = () => { done(); reject(new Error('network run cancelled')); };
    const timer = setTimeout(() => { done(); resolve(); }, ms); signal.addEventListener('abort', cancel, { once: true });
  });
  let result: T;
  let cleanupFailed = false;
  try {
    // Exclusive audit creation precedes every mutation and prevents accidental rerun reuse.
    await writeFile(scope.auditPath, `${JSON.stringify({ event: 'scope', ...scope, profile, provenance: 'linux-netns-controller' })}\n`, { flag: 'wx', mode: 0o600 });
    if (signal.aborted) throw new Error('network run cancelled');
    const links = JSON.parse(await invoke(['-n',scope.namespace,'-j','-d','link','show'])) as { ifname: string; ifalias?: string; linkinfo?: { info_kind?: string } }[];
    if (!Array.isArray(links) || links.some(l => !['lo','uplink','guest'].includes(l.ifname))) throw new Error('namespace is not an isolated two-link router');
    for (const iface of ['uplink','guest'] as const) {
      const matches = links.filter(l => l.ifname === iface);
      if (matches.length !== 1 || matches[0].linkinfo?.info_kind !== 'veth' || matches[0].ifalias !== `hq-meet:${scope.runId}:${scope.deviceId}:${iface}`) throw new Error('unowned namespace interface');
      const before = await show(iface);
      if (before.trim() && !/^qdisc noqueue 0: root[^\n]*\n?(?: Sent[^\n]*\n?\s*backlog[^\n]*\n?)?$/.test(before.trim())) throw new Error('refusing existing namespace shaping');
    }
    const baseline = new Map<string,number>();
    for (const iface of ['uplink','guest'] as const) {
      owned.push(iface); await invoke(shapingArguments(scope,profile,iface,'add')); 
      const observed = await show(iface); baseline.set(iface, verifyShaping(observed,profile,iface));
      await audit({ event: 'applied-verified', iface, observed });
    }
    result = await operation({ signal, collectionStarted: () => {
      if (started) throw new Error('network collection already started');
      started = true; start = performance.now();
      if (profile === 'sleep-reconnect') fault = (async () => {
        await delay(10000);
        for (const iface of owned) { await invoke(shapingArguments(scope,profile,iface,'change',true)); verifyShaping(await show(iface),profile,iface,true); }
        await audit({ event: 'disconnect-verified', atMs: performance.now() - start, deviceId: scope.deviceId });
        await delay(3000);
        for (const iface of owned) { await invoke(shapingArguments(scope,profile,iface,'change')); verifyShaping(await show(iface),profile,iface); }
        await audit({ event: 'network-return-verified', atMs: performance.now() - start, deviceId: scope.deviceId });
      })().catch(error => { faultError = error; abort.abort(); });
    } });
    if (!started) throw new Error('collector did not establish timing origin');
    await fault;
    if (faultError) throw faultError;
    if (signal.aborted) throw new Error('network run cancelled');
    for (const iface of owned) {
      const observed = await show(iface);
      if (verifyShaping(observed,profile,iface) <= baseline.get(iface)!) throw new Error('no measured traffic through shaped router');
      await audit({ event: 'traffic-verified', iface, observed });
    }
  } finally {
    abort.abort(); await fault; clearTimeout(timeout);
    for (const iface of owned.reverse()) {
      try {
        const args = ['netns','exec',scope.namespace,'tc','qdisc','del','dev',iface,'root','handle','712:'];
        await audit({ event: 'cleanup-start', args }).catch(() => { cleanupFailed = true; });
        // Cleanup must still execute if the audit disk filled after application.
        await command(args);
        if ((await command(['netns','exec',scope.namespace,'tc','-s','qdisc','show','dev',iface])).includes('qdisc netem 712:')) throw new Error('cleanup verification failed');
        await audit({ event: 'cleanup-verified', iface });
      } catch { cleanupFailed = true; await audit({ event: 'cleanup-failed', iface }).catch(() => {}); }
    }
    if (cleanupFailed) throw new Error('network cleanup failed: inspect namespace audit before reuse');
  }
  return { result: result!, networkArtifact: { path: scope.auditPath, kind: 'network-shaping', status: 'verified-and-cleaned', deviceId: scope.deviceId } };
}
