/** Native host observations using fixed OS commands, never arbitrary configured shell code. */
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { arch, cpus, platform, totalmem } from 'node:os';

const exec = promisify(execFile);
async function command(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const result = await exec(file, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024,
      windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    return { ...result, ok: true };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', ok: false };
  }
}
async function required(file: string, args: string[]): Promise<string> {
  const result = await command(file, args);
  if (!result.ok) throw new Error('native host observation failed');
  return result.stdout.trim();
}
export async function hashFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 2_000_000_000) throw new Error('invalid bounded host artifact');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
export function parseResourceSample(cpu: string, rssKiB: string): { cpuPercent: number; rssBytes: number } {
  const cpuPercent = Number(cpu.trim()), rssBytes = Number(rssKiB.trim()) * 1024;
  if (!cpu.trim() || !rssKiB.trim() || !Number.isFinite(cpuPercent) || cpuPercent < 0 ||
      !Number.isFinite(rssBytes) || rssBytes <= 0) throw new Error('invalid native process resource sample');
  return { cpuPercent, rssBytes };
}
export function parseMacSignature(verificationOK: boolean, output: string): {
  valid: boolean; teamIdentifier: string | null; kind: 'developer-id-or-distribution' | 'adhoc-or-unknown';
} {
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(output)?.[1] ?? null;
  const valid = verificationOK && /^Authority=.+$/m.test(output) && !/^Signature=adhoc$/m.test(output) && Boolean(teamIdentifier && teamIdentifier !== 'not set');
  return { valid, teamIdentifier, kind: valid ? 'developer-id-or-distribution' : 'adhoc-or-unknown' };
}
export interface HostObservation {
  schema: 'hq-meet-host-observation/v1'; provenance: 'native-os-commands'; deviceId: string;
  hostId: string; sessionBinding?: { webdriverUrl: string; sessionId: string; probeNonce: string };
  platform: 'macos' | 'windows'; osVersion: string; architecture: string; hardwareModel: string;
  logicalCpuCount: number; physicalMemoryBytes: number; pid: number; binarySha256: string;
  signature: { valid: boolean; tool: string; signerId: string | null };
  package: { kind: 'app-bundle' | 'executable-install-unverified'; minimumOS: string | null };
  resources: { atMs: number; cpuPercent: number; rssBytes: number }[];
}
const windowsScript = `
$ErrorActionPreference = 'Stop'
$p = Get-Process -Id ([int]$env:HQ_MEET_COLLECT_PID)
$os = Get-CimInstance Win32_OperatingSystem
$hw = Get-CimInstance Win32_ComputerSystem
$uuid = (Get-CimInstance Win32_ComputerSystemProduct).UUID
$sig = Get-AuthenticodeSignature -LiteralPath $p.Path
[pscustomobject]@{ executable=$p.Path; cpuSeconds=$p.TotalProcessorTime.TotalSeconds; rssBytes=$p.WorkingSet64;
hostUuid=$uuid; osVersion=$os.Version; model=($hw.Manufacturer+' '+$hw.Model); signatureValid=($sig.Status -eq 'Valid');
signerId=$sig.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress
`;
const windowsResourceScript = `$ErrorActionPreference = 'Stop'; $p = Get-Process -Id ([int]$env:HQ_MEET_COLLECT_PID);
[pscustomobject]@{executable=$p.Path;cpuSeconds=$p.TotalProcessorTime.TotalSeconds;rssBytes=$p.WorkingSet64} | ConvertTo-Json -Compress`;
async function windowsSample(pid: number, identity = false): Promise<Record<string, unknown>> {
  const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(identity ? windowsScript : windowsResourceScript, 'utf16le').toString('base64')], { HQ_MEET_COLLECT_PID: String(pid) });
  if (!result.ok) throw new Error('Windows host observation failed');
  return JSON.parse(result.stdout);
}
export async function collectHost(options: {
  deviceId: string; pid: number; executablePath: string; bundlePath?: string; durationMs: number; signal?: AbortSignal;
  sessionBinding?: { webdriverUrl: string; sessionId: string; probeNonce: string };
}): Promise<HostObservation> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.deviceId) || !Number.isSafeInteger(options.pid) || options.pid < 1 ||
      !isAbsolute(options.executablePath) || !Number.isInteger(options.durationMs) || options.durationMs < 1000 || options.durationMs > 3_600_000) throw new Error('invalid native host collection options');
  const os = platform();
  if (os !== 'darwin' && os !== 'win32') throw new Error('native host collector requires macOS or Windows');
  const executable = await realpath(options.executablePath);
  let observation: HostObservation;
  if (os === 'darwin') {
    if (!options.bundlePath || !isAbsolute(options.bundlePath)) throw new Error('Mac collection requires actual app bundle');
    const bundle = await realpath(options.bundlePath);
    if (!bundle.endsWith('.app') || !executable.startsWith(`${bundle}/Contents/MacOS/`)) throw new Error('running binary is outside app bundle');
    const observed = await realpath(await required('/bin/ps', ['-p', String(options.pid), '-o', 'comm=']));
    if (observed !== executable) throw new Error('PID does not match intended executable');
    const verification = await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    const details = await command('/usr/bin/codesign', ['-d', '--verbose=4', bundle]);
    const signature = parseMacSignature(verification.ok, details.stderr);
    const minimum = await command('/usr/bin/plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')]);
    observation = { schema: 'hq-meet-host-observation/v1', provenance: 'native-os-commands', deviceId: options.deviceId,
      hostId: hashHostIdentity(await required('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']), 'macos'),
      platform: 'macos', osVersion: await required('/usr/bin/sw_vers', ['-productVersion']), architecture: arch(),
      hardwareModel: await required('/usr/sbin/sysctl', ['-n', 'hw.model']), logicalCpuCount: cpus().length,
      physicalMemoryBytes: totalmem(), pid: options.pid, binarySha256: await hashFile(executable),
      signature: { valid: signature.valid, tool: 'codesign', signerId: signature.teamIdentifier },
      package: { kind: 'app-bundle', minimumOS: minimum.ok ? minimum.stdout.trim() : null }, resources: [] };
  } else {
    const first = await windowsSample(options.pid, true);
    if (typeof first.executable !== 'string' || (await realpath(first.executable)).toLowerCase() !== executable.toLowerCase()) throw new Error('PID does not match intended executable');
    if (typeof first.osVersion !== 'string' || typeof first.model !== 'string') throw new Error('missing Windows host identity');
    observation = { schema: 'hq-meet-host-observation/v1', provenance: 'native-os-commands', deviceId: options.deviceId,
      hostId: hashHostIdentity(String(first.hostUuid ?? ''), 'windows'),
      platform: 'windows', osVersion: first.osVersion, architecture: arch(), hardwareModel: first.model,
      logicalCpuCount: cpus().length, physicalMemoryBytes: totalmem(), pid: options.pid, binarySha256: await hashFile(executable),
      signature: { valid: first.signatureValid === true, tool: 'Get-AuthenticodeSignature', signerId: typeof first.signerId === 'string' ? first.signerId : null },
      package: { kind: 'executable-install-unverified', minimumOS: null }, resources: [] };
  }
  if (options.sessionBinding) {
    await verifyLocalProbeBinding(options.pid, options.sessionBinding);
    observation.sessionBinding = { ...options.sessionBinding };
  }
  const start = performance.now();
  let previousCpuSeconds: number | undefined, previousAt = 0;
  do {
    if (options.signal?.aborted) throw new Error('host collection cancelled');
    const atMs = performance.now() - start;
    if (os === 'darwin') {
      const [observed, cpu, rss] = await Promise.all([
        required('/bin/ps', ['-p', String(options.pid), '-o', 'comm=']),
        required('/bin/ps', ['-p', String(options.pid), '-o', '%cpu=']),
        required('/bin/ps', ['-p', String(options.pid), '-o', 'rss=']),
      ]);
      if (await realpath(observed) !== executable) throw new Error('native process identity changed');
      observation.resources.push({ atMs, ...parseResourceSample(cpu, rss) });
    } else {
      const sample = await windowsSample(options.pid);
      if (typeof sample.executable !== 'string' || (await realpath(sample.executable)).toLowerCase() !== executable.toLowerCase() ||
          typeof sample.cpuSeconds !== 'number' || !Number.isFinite(sample.cpuSeconds) ||
          typeof sample.rssBytes !== 'number' || !Number.isFinite(sample.rssBytes) || sample.rssBytes <= 0) throw new Error('invalid Windows process sample');
      if (previousCpuSeconds !== undefined) {
        const cpuPercent = (sample.cpuSeconds - previousCpuSeconds) * 100_000 / (atMs - previousAt);
        if (!Number.isFinite(cpuPercent) || cpuPercent < 0) throw new Error('Windows process CPU counter regressed');
        observation.resources.push({ atMs, cpuPercent, rssBytes: sample.rssBytes });
      }
      previousCpuSeconds = sample.cpuSeconds; previousAt = atMs;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
  } while (performance.now() - start <= options.durationMs);
  if (await hashFile(executable) !== observation.binarySha256) throw new Error('running binary changed during collection');
  if (options.sessionBinding) await verifyLocalProbeBinding(options.pid, options.sessionBinding);
  return observation;
}

/** Persist only a digest of the OS hardware UUID, never serials or raw hardware IDs. */
export function hashHostIdentity(raw: string, os: 'macos' | 'windows'): string {
  const uuid = (os === 'macos' ? /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(raw)?.[1] : raw)?.trim().toLowerCase();
  if (!uuid || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uuid) || /^(0|-)+$/.test(uuid) || /^(f|-)+$/.test(uuid)) throw new Error('missing actual host identity');
  return createHash('sha256').update(`hq-meet-host-v1:${uuid}`).digest('hex');
}
async function verifyLocalProbeBinding(pid: number, binding: { webdriverUrl: string; sessionId: string; probeNonce: string }): Promise<void> {
  const url = new URL(binding.webdriverUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(binding.sessionId) || !/^[a-f0-9]{64}$/.test(binding.probeNonce)) throw new Error('invalid local probe binding');
  const port = Number(url.port || 80);
  let owners: number[];
  if (platform() === 'darwin') {
    owners = (await required('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).split(/\s+/).map(Number);
  } else {
    const script = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess`;
    owners = (await required('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])).split(/\s+/).map(Number);
  }
  // A tunnel/proxy PID is not proof that this app owns the WebDriver session.
  if (!owners.length || owners.some(owner => owner !== pid)) throw new Error('WebDriver listener does not belong to observed app PID');
  const response = await fetch(`${url.origin}/session/${binding.sessionId}/execute/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ script: 'return globalThis.__hqMeetProbe?.identity();', args: [] }),
  });
  const result = await response.json() as { value?: { probeNonce?: string } };
  if (!response.ok || result.value?.probeNonce !== binding.probeNonce) throw new Error('observed PID/session probe nonce mismatch');
}
