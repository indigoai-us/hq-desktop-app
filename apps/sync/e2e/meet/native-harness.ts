/** Strict evidence boundary. Native collection and synthetic validator tests are separate. */
import { createPublicKey, verify } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fixtureManifest, profiles, sha256, type Profile } from './fixtures';

type ObjectValue = Record<string, unknown>;
export interface Artifact { path: string; sha256: string; kind: string }
export interface Direction {
  from: string; to: string;
  samples: { atMs: number; audioDelayMs: number; screenDelayMs?: number; audioGapMs: number;
    clockUncertaintyMs: number; receivedAudioFrames: number; receivedVideoFrames: number;
    bytesReceived: number; bytesSent: number; localCandidate: string; remoteCandidate: string }[];
  artifacts: Artifact[];
  screenReadable: boolean;
  recovery?: { networkReturnedMs: number; resolvedMs: number; outcome: 'audio-connected' | 'explicit-user-retry' };
}
export interface Device {
  id: string; platform: 'macos' | 'windows'; osVersion: string; hardwareModel: string;
  runtime: 'WKWebView' | 'WebView2'; binarySha256: string; commit: string;
  signed: boolean; packaged: boolean; releaseEquivalent: boolean; permissionPromptsBypassed: boolean;
  resources: { atMs: number; cpuPercent: number; rssBytes: number }[];
  artifacts: Artifact[];
}
export interface NativeEvidence {
  schema: 'hq-meet-native-evidence/v1'; provenance: 'native-device-collector';
  runId: string; screenSourceId: string; profile: Profile; participants: 2 | 4 | 8; durationMs: number;
  fixtures: typeof fixtureManifest;
  devices: Device[]; directions: Direction[];
  inducedDisconnects: { deviceId: string; startMs: number; endMs: number; artifact: Artifact }[];
  networkArtifact: Artifact;
}
export interface Receipt {
  schema: 'hq-meet-native-receipt/v1'; runId: string; status: 'pass' | 'fail';
  provenance: 'verified-native-device-collector'; evidenceSha256: string;
  failures: string[]; artifactCount: number;
}

const object = (v: unknown): ObjectValue => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected object');
  return v as ObjectValue;
};
const text = (v: unknown): string => {
  if (typeof v !== 'string' || !v.length || v.length > 300) throw new Error('invalid string');
  return v;
};
const number = (v: unknown, max = 1e12): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new Error('invalid finite number');
  return v;
};
const boolean = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new Error('expected boolean');
  return v;
};
const array = (v: unknown, max: number): unknown[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error('invalid bounded array');
  return v;
};
const member = <T extends string>(v: unknown, allowed: readonly T[]): T => {
  if (!allowed.includes(v as T)) throw new Error('unexpected enum value');
  return v as T;
};
const digest = (v: unknown): string => {
  const s = text(v);
  if (!/^[a-f0-9]{64}$/.test(s)) throw new Error('invalid SHA-256');
  return s;
};
const id = (v: unknown): string => {
  const s = text(v);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(s)) throw new Error('invalid opaque id');
  return s;
};
const artifact = (v: unknown): Artifact => {
  const a = object(v);
  const path = text(a.path);
  if (isAbsolute(path) || path.split(/[\\/]/).some(p => p === '..' || p === '')) throw new Error('invalid artifact path');
  return { path, sha256: digest(a.sha256), kind: id(a.kind) };
};
const artifacts = (v: unknown): Artifact[] => array(v, 32).map(artifact);

/** Reconstruct whitelisted fields; neither SDP, candidate addresses nor content enter receipts. */
export function parseEvidence(input: unknown): NativeEvidence {
  const v = object(input);
  const durationMs = number(v.durationMs, 3_600_000);
  if (durationMs < 30_000) throw new Error('native run must span at least 30 seconds');
  const participants = number(v.participants);
  if (![2, 4, 8].includes(participants)) throw new Error('participant ladder must be 2, 4 or 8');
  const fixture = object(v.fixtures);
  if (JSON.stringify(Object.keys(fixture).sort()) !== JSON.stringify(Object.keys(fixtureManifest).sort()) ||
      Object.entries(fixtureManifest).some(([k, val]) => fixture[k] !== val)) throw new Error('fixture manifest mismatch');
  return {
    schema: member(v.schema, ['hq-meet-native-evidence/v1']),
    provenance: member(v.provenance, ['native-device-collector']),
    runId: id(v.runId), screenSourceId: id(v.screenSourceId), profile: member(v.profile, Object.keys(profiles) as Profile[]),
    participants: participants as 2 | 4 | 8, durationMs, fixtures: fixtureManifest,
    devices: array(v.devices, 8).map(raw => {
      const d = object(raw);
      return {
        id: id(d.id), platform: member(d.platform, ['macos', 'windows']), osVersion: text(d.osVersion),
        hardwareModel: text(d.hardwareModel), runtime: member(d.runtime, ['WKWebView', 'WebView2']),
        binarySha256: digest(d.binarySha256), commit: text(d.commit),
        signed: boolean(d.signed), packaged: boolean(d.packaged), releaseEquivalent: boolean(d.releaseEquivalent),
        permissionPromptsBypassed: boolean(d.permissionPromptsBypassed),
        resources: array(d.resources, 7201).map(rawSample => {
          const s = object(rawSample);
          return { atMs: number(s.atMs, durationMs), cpuPercent: number(s.cpuPercent, 100_000), rssBytes: number(s.rssBytes) };
        }), artifacts: artifacts(d.artifacts),
      };
    }),
    directions: array(v.directions, 56).map(raw => {
      const d = object(raw);
      let recovery: Direction['recovery'];
      if (d.recovery !== undefined) {
        const r = object(d.recovery);
        recovery = { networkReturnedMs: number(r.networkReturnedMs, durationMs), resolvedMs: number(r.resolvedMs, durationMs),
          outcome: member(r.outcome, ['audio-connected', 'explicit-user-retry']) };
      }
      return {
        from: id(d.from), to: id(d.to), screenReadable: boolean(d.screenReadable), artifacts: artifacts(d.artifacts), recovery,
        samples: array(d.samples, 36_001).map(rawSample => {
          const s = object(rawSample);
          return {
            atMs: number(s.atMs, durationMs), audioDelayMs: number(s.audioDelayMs, durationMs),
            screenDelayMs: s.screenDelayMs === undefined ? undefined : number(s.screenDelayMs, durationMs), audioGapMs: number(s.audioGapMs, durationMs),
            clockUncertaintyMs: number(s.clockUncertaintyMs, 1000),
            receivedAudioFrames: number(s.receivedAudioFrames), receivedVideoFrames: number(s.receivedVideoFrames),
            bytesReceived: number(s.bytesReceived), bytesSent: number(s.bytesSent),
            localCandidate: member(s.localCandidate, ['host', 'srflx', 'prflx', 'relay']),
            remoteCandidate: member(s.remoteCandidate, ['host', 'srflx', 'prflx', 'relay']),
          };
        }),
      };
    }),
    inducedDisconnects: array(v.inducedDisconnects, 16).map(raw => {
      const i = object(raw);
      return { deviceId: id(i.deviceId), startMs: number(i.startMs, durationMs), endMs: number(i.endMs, durationMs), artifact: artifact(i.artifact) };
    }),
    networkArtifact: artifact(v.networkArtifact),
  };
}
export const p95 = (values: number[]): number => {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error('p95 needs finite samples');
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
};

/** Pure validator only: passing this function is NOT a native receipt. */
export function evaluateEvidence(input: unknown): string[] {
  const e = parseEvidence(input);
  const failures: string[] = [];
  const fail = (test: boolean, message: string) => { if (!test) failures.push(message); };
  const ids = new Set(e.devices.map(d => d.id));
  fail(ids.has(e.screenSourceId), 'screen source is not a participant');
  fail(e.devices.length === e.participants && ids.size === e.participants, 'devices: missing or duplicate participant');
  fail(e.devices.some(d => d.platform === 'macos') && e.devices.some(d => d.platform === 'windows'), 'platforms: mixed native Mac/Windows coverage required');
  const coverage = (samples: { atMs: number }[], label: string, maxGap: number) => {
    fail(samples.length >= 30, `${label}: insufficient samples`);
    fail(samples[0]?.atMs <= maxGap && samples.at(-1)!.atMs >= e.durationMs - maxGap, `${label}: incomplete duration`);
    for (let n = 1; n < samples.length; n++) fail(samples[n].atMs > samples[n - 1].atMs && samples[n].atMs - samples[n - 1].atMs <= maxGap, `${label}: missing/out-of-order samples`);
  };
  const requireKinds = (refs: Artifact[], kinds: string[], label: string) => {
    for (const k of kinds) fail(refs.some(a => a.kind === k), `${label}: missing ${k} artifact`);
  };
  for (const d of e.devices) {
    fail(d.signed && d.packaged && d.releaseEquivalent && !d.permissionPromptsBypassed, `${d.id}: signed packaged release-equivalent native runtime required`);
    fail(d.runtime === (d.platform === 'macos' ? 'WKWebView' : 'WebView2'), `${d.id}: runtime/platform mismatch`);
    fail(/^[0-9a-f]{40}$/.test(d.commit), `${d.id}: full commit required`);
    requireKinds(d.artifacts, ['signature-verification', 'os-hardware', 'process-resources', 'permissions', 'supported-baseline'], d.id);
    coverage(d.resources, `${d.id} resources`, 2000);
    fail(d.resources.every(s => s.rssBytes > 0), `${d.id}: zero process memory`);
  }
  for (const interval of e.inducedDisconnects) {
    fail(ids.has(interval.deviceId) && interval.endMs > interval.startMs && interval.endMs - interval.startMs <= 20_000, 'invalid induced disconnect interval');
    fail(interval.artifact.kind === 'fault-injection', 'disconnect requires fault artifact');
  }
  fail(e.inducedDisconnects.every((i, n, all) => all.slice(0, n).every(j => j.deviceId !== i.deviceId || i.startMs >= j.endMs || j.startMs >= i.endMs)), 'overlapping disconnect intervals');
  fail(e.profile === 'sleep-reconnect' ? e.inducedDisconnects.length > 0 : e.inducedDisconnects.length === 0, 'unexpected/missing induced disconnect');
  fail(e.networkArtifact.kind === 'network-shaping', 'network profile requires shaping verification artifact');
  const keys = new Set<string>();
  for (const d of e.directions) {
    const key = `${d.from}->${d.to}`;
    fail(ids.has(d.from) && ids.has(d.to) && d.from !== d.to && !keys.has(key), `${key}: invalid/duplicate direction`);
    keys.add(key);
    coverage(d.samples, key, 1000);
    requireKinds(d.artifacts, ['rtc-stats', 'receiver-audio-markers', 'receiver-video-markers', 'clock-calibration'], key);
    if (d.from === e.screenSourceId) {
      requireKinds(d.artifacts, ['receiver-screenshot', 'legibility-review'], key);
      fail(d.screenReadable, `${key}: reference 14pt text unreadable`);
      fail(d.samples.every(s => s.screenDelayMs !== undefined), `${key}: missing screen latency`);
    }
    for (let n = 1; n < d.samples.length; n++) {
      const prev = d.samples[n - 1], s = d.samples[n];
      fail(s.receivedAudioFrames >= prev.receivedAudioFrames && s.receivedVideoFrames >= prev.receivedVideoFrames && s.bytesReceived >= prev.bytesReceived && s.bytesSent >= prev.bytesSent, `${key}: counters regressed`);
    }
    const first = d.samples[0], last = d.samples.at(-1);
    fail(Boolean(first && last && last.receivedAudioFrames > first.receivedAudioFrames && last.receivedVideoFrames > first.receivedVideoFrames && last.bytesReceived > first.bytesReceived && last.bytesSent > first.bytesSent), `${key}: no bidirectional media progress`);
    const steady = d.samples.filter(s => !e.inducedDisconnects.some(i =>
      (i.deviceId === d.from || i.deviceId === d.to) && s.atMs >= i.startMs && s.atMs <= i.endMs));
    fail(steady.length >= 30, `${key}: insufficient steady media samples`);
    if (steady.length) {
      fail(p95(steady.map(s => s.audioDelayMs + s.clockUncertaintyMs)) <= (e.profile === 'constrained' ? 500 : 300), `${key}: audio p95 exceeded`);
      if (d.from === e.screenSourceId && steady.every(s => s.screenDelayMs !== undefined)) {
        fail(p95(steady.map(s => s.screenDelayMs! + s.clockUncertaintyMs)) <= (e.profile === 'constrained' ? 3000 : 1500), `${key}: screen p95 exceeded`);
      }
    }
    for (const s of d.samples) {
      // Exempt only the exact overlapping part of a gap, never the whole sample.
      const start = s.atMs - s.audioGapMs;
      const spans = e.inducedDisconnects.filter(i => i.deviceId === d.from || i.deviceId === d.to)
        .map(i => [Math.max(start, i.startMs), Math.min(s.atMs, i.endMs)])
        .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
      let excluded = 0, end = start;
      for (const [a, b] of spans) { excluded += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
      fail(s.audioGapMs - excluded <= 2000, `${key}: unexplained audio gap exceeds 2 seconds`);
      fail(s.clockUncertaintyMs <= 50, `${key}: clock uncertainty exceeds 50ms`);
      if (e.profile === 'forced-turn') fail(s.localCandidate === 'relay' || s.remoteCandidate === 'relay', `${key}: forced TURN did not select relay`);
      if (e.profile === 'direct') fail(s.localCandidate !== 'relay' && s.remoteCandidate !== 'relay', `${key}: direct profile selected relay`);
    }
    const faults = e.inducedDisconnects.filter(i => i.deviceId === d.from || i.deviceId === d.to);
    if (faults.length) {
      fail(faults.length === 1, `${key}: each recovery needs a distinct evidence run`);
      const r = d.recovery;
      fail(Boolean(r && r.networkReturnedMs === faults[0].endMs && r.resolvedMs >= r.networkReturnedMs && r.resolvedMs - r.networkReturnedMs <= 20_000), `${key}: recovery exceeded 20 seconds or missing explicit outcome`);
    }
  }
  for (const from of ids) for (const to of ids) if (from !== to) fail(keys.has(`${from}->${to}`), `${from}->${to}: missing direction`);
  return [...new Set(failures)];
}

/** Verify collector signature over exact evidence bytes and every content-addressed artifact. */
export async function verifyNativeEvidence(options: {
  root: string; evidencePath: string; signature: Uint8Array; trustedPublicKeyPem: string;
}): Promise<Receipt> {
  const root = await realpath(options.root);
  const readBounded = async (path: string, limit: number): Promise<Buffer> => {
    const full = await realpath(resolve(root, path));
    const rel = relative(root, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('artifact escapes evidence root');
    const info = await lstat(full);
    if (!info.isFile() || info.size > limit) throw new Error('invalid artifact size/type');
    return readFile(full);
  };
  const bytes = await readBounded(options.evidencePath, 32 * 1024 * 1024);
  const key = createPublicKey(options.trustedPublicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, options.signature)) throw new Error('native collector signature rejected');
  const e = parseEvidence(JSON.parse(bytes.toString('utf8')));
  const refs = [e.networkArtifact, ...e.devices.flatMap(d => d.artifacts), ...e.directions.flatMap(d => d.artifacts), ...e.inducedDisconnects.map(i => i.artifact)];
  const paths = new Map<string, string>();
  for (const ref of refs) {
    if (paths.has(ref.path) && paths.get(ref.path) !== ref.sha256) throw new Error('conflicting artifact hashes');
    paths.set(ref.path, ref.sha256);
    if (sha256(await readBounded(ref.path, 64 * 1024 * 1024)) !== ref.sha256) throw new Error('native artifact hash mismatch');
  }
  const failures = evaluateEvidence(e);
  return { schema: 'hq-meet-native-receipt/v1', runId: e.runId, status: failures.length ? 'fail' : 'pass',
    provenance: 'verified-native-device-collector', evidenceSha256: sha256(bytes), failures, artifactCount: paths.size };
}
