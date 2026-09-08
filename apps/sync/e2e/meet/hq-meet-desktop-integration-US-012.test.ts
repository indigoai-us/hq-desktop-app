/** Synthetic validator regressions. These tests do not certify native calls. */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateEvidence, parseEvidence, p95, verifyNativeEvidence, type NativeEvidence } from './native-harness';
import { fixtureManifest, fileFixture, fileFixtureHash, sha256 } from './fixtures';
import { parseEndpoints } from './webdriver-driver';

const ref = (kind: string) => ({ kind, path: `${kind}.json`, sha256: 'a'.repeat(64) });
function synthetic(): NativeEvidence {
  return {
    schema: 'hq-meet-native-evidence/v1', provenance: 'native-device-collector', runId: 'synthetic-test-only',
    screenSourceId: 'a', profile: 'direct', participants: 2, durationMs: 30_000, fixtures: fixtureManifest,
    devices: (['a', 'b'] as const).map((id, i) => ({ id, platform: i ? 'windows' : 'macos',
      runtime: i ? 'WebView2' : 'WKWebView', osVersion: i ? '11-24H2' : '13.0', hardwareModel: 'synthetic-only',
      binarySha256: 'b'.repeat(64), commit: 'c'.repeat(40), signed: true, packaged: true,
      releaseEquivalent: true, permissionPromptsBypassed: false,
      resources: Array.from({ length: 31 }, (_, n) => ({ atMs: n * 1000, cpuPercent: 40, rssBytes: 100_000_000 })),
      artifacts: ['signature-verification', 'os-hardware', 'process-resources', 'permissions', 'supported-baseline'].map(ref),
    })),
    directions: [['a', 'b'], ['b', 'a']].map(([from, to]) => ({ from, to, screenReadable: true,
      artifacts: ['rtc-stats', 'receiver-audio-markers', 'receiver-video-markers', 'receiver-screenshot', 'legibility-review', 'clock-calibration'].map(ref),
      samples: Array.from({ length: 61 }, (_, n) => ({ atMs: n * 500, audioDelayMs: 180,
        screenDelayMs: 800, clockUncertaintyMs: 5, audioGapMs: 0,
        receivedAudioFrames: n * 100, receivedVideoFrames: n * 10, bytesReceived: n * 5000, bytesSent: n * 6000,
        localCandidate: 'host', remoteCandidate: 'srflx',
      })),
    })), inducedDisconnects: [], networkArtifact: ref('network-shaping'),
  };
}

describe('US-012 synthetic evidence validator (not native certification)', () => {
  it('accepts complete synthetic input only as an empty failure list', () => {
    expect(evaluateEvidence(synthetic())).toEqual([]);
  });
  it('rejects non-finite, malformed and missing required fields', () => {
    const e = synthetic(); e.directions[0].samples[0].audioDelayMs = NaN;
    expect(() => parseEvidence(e)).toThrow('finite');
    expect(() => parseEvidence({ ...synthetic(), devices: null })).toThrow();
    expect(() => parseEvidence({ ...synthetic(), provenance: 'browser-mock' })).toThrow();
  });
  it('fails missing direction, duplicate device and missing platform', () => {
    const e = synthetic(); e.directions.pop(); expect(evaluateEvidence(e)).toContain('b->a: missing direction');
    const duplicate = synthetic(); duplicate.devices[1].id = 'a';
    expect(evaluateEvidence(duplicate)).toContain('devices: missing or duplicate participant');
    const same = synthetic(); same.devices[1].platform = 'macos'; same.devices[1].runtime = 'WKWebView';
    expect(evaluateEvidence(same)).toContain('platforms: mixed native Mac/Windows coverage required');
  });
  it('does not accept a samples array with gaps or no actual media progress', () => {
    const e = synthetic(); e.directions[0].samples.splice(2, 4);
    expect(evaluateEvidence(e)).toContain('a->b: missing/out-of-order samples');
    const frozen = synthetic(); frozen.directions[0].samples.forEach(s => { s.receivedAudioFrames = 1; });
    expect(evaluateEvidence(frozen)).toContain('a->b: no bidirectional media progress');
    const empty = synthetic(); empty.directions[0].samples = [];
    expect(evaluateEvidence(empty)).toContain('a->b: insufficient samples');
  });
  it('fails a measured dropout even when aggregate received counters increase', () => {
    const e = synthetic(); e.directions[0].samples[10].audioGapMs = 2001;
    expect(evaluateEvidence(e)).toContain('a->b: unexplained audio gap exceeds 2 seconds');
  });
  it('subtracts only exact induced-disconnect overlap from gaps', () => {
    const e = synthetic(); e.profile = 'sleep-reconnect';
    e.inducedDisconnects = [{ deviceId: 'a', startMs: 10_000, endMs: 12_000, artifact: ref('fault-injection') }];
    for (const d of e.directions) d.recovery = { networkReturnedMs: 12_000, resolvedMs: 13_000, outcome: 'audio-connected' };
    e.directions[0].samples[24].audioGapMs = 4001;
    expect(evaluateEvidence(e)).toContain('a->b: unexplained audio gap exceeds 2 seconds');
    e.directions[0].samples[24].audioGapMs = 4000;
    expect(evaluateEvidence(e)).toEqual([]);
  });
  it('rejects falsely claimed TURN, missing artifact and unsigned automation bytes', () => {
    const e = synthetic(); e.profile = 'forced-turn';
    expect(evaluateEvidence(e)).toContain('a->b: forced TURN did not select relay');
    e.devices[0].signed = false;
    expect(evaluateEvidence(e)).toContain('a: signed packaged release-equivalent native runtime required');
    e.directions[0].artifacts = [];
    expect(evaluateEvidence(e)).toContain('a->b: missing receiver-audio-markers artifact');
  });
  it('includes clock uncertainty in locked audio and screen latency budgets', () => {
    const e = synthetic(); e.directions[0].samples.forEach(s => { s.audioDelayMs = 298; });
    expect(evaluateEvidence(e)).toContain('a->b: audio p95 exceeded');
    e.profile = 'constrained'; expect(evaluateEvidence(e)).toEqual([]);
    e.directions[0].samples.forEach(s => { s.screenDelayMs = 3000; });
    expect(evaluateEvidence(e)).toContain('a->b: screen p95 exceeded');
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });
  it('requires recovery to start at verified network return and finish within 20s', () => {
    const e = synthetic(); e.profile = 'sleep-reconnect';
    e.inducedDisconnects = [{ deviceId: 'a', startMs: 1000, endMs: 2000, artifact: ref('fault-injection') }];
    e.directions[0].recovery = { networkReturnedMs: 2001, resolvedMs: 2100, outcome: 'explicit-user-retry' };
    expect(evaluateEvidence(e)).toContain('a->b: recovery exceeded 20 seconds or missing explicit outcome');
  });
  it('pins deterministic fixture bytes across chunk boundaries and rejects oversized fixtures', () => {
    expect(fileFixtureHash(65539)).toBe(sha256(Buffer.concat([...fileFixture(65539)])));
    expect(() => [...fileFixture(100_000_001)]).toThrow();
  });
  it('rejects duplicate sessions and non-loopback WebDriver endpoints', () => {
    const a = { id: 'a', sessionId: 'one', webdriverUrl: 'http://127.0.0.1:4444' };
    expect(() => parseEndpoints([a, { ...a, id: 'b' }])).toThrow('duplicate');
    expect(() => parseEndpoints([a, { ...a, id: 'b', webdriverUrl: 'http://example.com' }])).toThrow('loopback');
  });
  it('fails closed on invalid collector signature and artifact tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meet-validator-'));
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const bytes = Buffer.from(JSON.stringify(synthetic()));
      await writeFile(join(root, 'evidence.json'), bytes);
      const options = { root, evidencePath: 'evidence.json', signature: sign(null, bytes, privateKey),
        trustedPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
      await expect(verifyNativeEvidence({ ...options, signature: Buffer.alloc(64) })).rejects.toThrow('signature');
      await writeFile(join(root, 'network-shaping.json'), 'tampered');
      await expect(verifyNativeEvidence(options)).rejects.toThrow('hash mismatch');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
