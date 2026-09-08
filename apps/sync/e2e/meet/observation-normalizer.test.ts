/** Synthetic raw boundary regressions only, never native certification. */
import { describe, expect, it } from 'vitest';
import { calibrateClock, normalizeMarkers, verifySessionBindings, normalizeBoundDiagnostics, type SessionBinding } from './observation-normalizer';
import { hashHostIdentity } from './host-collector';
const clock = { offsetMs: 100, uncertaintyMs: 2 };
const emissions = [{ atMs: 0, sequence: 0 }, { atMs: 500, sequence: 1 }, { atMs: 1000, sequence: 2 }];
const observation = (atMs: number, sequence: number | null) => ({ atMs,
  audioMarker: sequence === null ? null : { sequenceModulo16: sequence },
  videoMarker: sequence === null ? null : { sequence } });
describe('raw observation normalization (unit regressions)', () => {
  it('intersects measured request windows and rejects drift or poor uncertainty', () => {
    expect(calibrateClock([0,100,200].map(t => ({ requestStartedMs: t + 100, responseReceivedMs: t + 104, remoteAtMs: t })))).toEqual({ offsetMs: 102, uncertaintyMs: 2 });
    expect(() => calibrateClock([0,100,200].map(t => ({ requestStartedMs: t, responseReceivedMs: t + 2, remoteAtMs: t * 2 })))).toThrow('drift');
    expect(() => calibrateClock([0,100,200].map(t => ({ requestStartedMs: t, responseReceivedMs: t + 101, remoteAtMs: t })))).toThrow('uncertainty');
  });
  it('derives delivery delay from changed raw markers and accounts for independent clocks', () => {
    const samples = normalizeMarkers({ emissions, sourceClock: clock, receiverClock: { offsetMs: 200, uncertaintyMs: 3 },
      observations: [observation(20,0), observation(220,0), observation(520,1)] });
    expect(samples.map(s => s.audioDelayMs)).toEqual([120,null,120]);
    expect(samples[0].clockUncertaintyMs).toBe(5);
    expect(samples[1].audioGapMs).toBe(200);
  });
  it('detects a receiver gap without relying on RTC counters or declared gap values', () => {
    const samples = normalizeMarkers({ emissions, sourceClock: clock, receiverClock: clock,
      observations: [observation(20,0), ...[520,1020,1520,2021].map(t => observation(t,null))] });
    expect(samples.at(-1)?.audioGapMs).toBe(2001);
  });
  it('rejects ambiguous modulo markers, absent emission proof and collection holes', () => {
    expect(() => normalizeMarkers({ emissions: [...emissions,{ atMs: 8000, sequence: 16 }], sourceClock: clock, receiverClock: clock,
      observations: [observation(9000,0)] })).toThrow('ambiguous');
    expect(() => normalizeMarkers({ emissions, sourceClock: clock, receiverClock: clock, observations: [observation(20,3)] })).toThrow('unmatched');
    expect(() => normalizeMarkers({ emissions, sourceClock: clock, receiverClock: clock, observations: [observation(20,0), observation(1021,1)] })).toThrow('missing');
  });
});
describe('independent host/session binding (unit regressions)', () => {
  const hosts: SessionBinding[] = ['a','b'].map((x,i) => ({ hostId: x.repeat(64), pid: i + 1,
    binarySha256: 'c'.repeat(64), sessionId: x, probeNonce: x.repeat(64), webdriverUrl: `http://127.0.0.1:${4444+i}` }));
  const expected = Object.fromEntries(hosts.map(h => [h.hostId, h.binarySha256]));
  it('accepts exact observed bindings but rejects changed nonce, binary, and duplicate physical host', () => {
    expect(() => verifySessionBindings(hosts, hosts, expected)).not.toThrow();
    expect(() => verifySessionBindings(hosts, [hosts[0],hosts[0]], expected)).toThrow('duplicate probe session');
    expect(() => verifySessionBindings(hosts, hosts.map((h,i) => i ? h : { ...h, probeNonce: 'f'.repeat(64) }), expected)).toThrow('mismatch');
    expect(() => verifySessionBindings(hosts.map((h,i) => i ? h : { ...h, binarySha256: 'd'.repeat(64) }), hosts, expected)).toThrow('binary');
    expect(() => verifySessionBindings(hosts.map((h,i) => i ? { ...h, hostId: hosts[0].hostId } : h), hosts, expected)).toThrow('duplicate actual host');
  });
  it('hashes the OS UUID consistently and rejects absent or placeholder identity', () => {
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    expect(hashHostIdentity(`"IOPlatformUUID" = "${uuid.toUpperCase()}"`, 'macos')).toBe(hashHostIdentity(uuid, 'windows'));
    expect(() => hashHostIdentity('', 'macos')).toThrow();
    expect(() => hashHostIdentity('00000000-0000-0000-0000-000000000000', 'windows')).toThrow();
  });
});

it('normalizes a complete raw diagnostic with independently bound hosts and rejects nonce tampering', () => {
  const endpoints = ['a','b'].map((id,i) => ({ id, sessionId: id, webdriverUrl: `http://127.0.0.1:${4444+i}`, probeNonce: id.repeat(64), screenshotPngBase64: '',
    samples: [100,600,1100].map((atMs,n) => ({ requestStartedMs: atMs, responseReceivedMs: atMs + 4,
      snapshot: { atMs, emissions: [{ atMs: atMs - 20, sequence: n }], peers: [{ ...observation(atMs,n), peerId: id === 'a' ? 'b' : 'a' }] } })) }));
  const hosts = endpoints.map((e,i) => ({ provenance: 'native-os-commands', signature: { valid: true }, hostId: e.id.repeat(64), pid: i + 1,
    binarySha256: 'c'.repeat(64), sessionBinding: { webdriverUrl: e.webdriverUrl, sessionId: e.sessionId, probeNonce: e.probeNonce } }));
  const diagnostic = { endpoints } as unknown as import('./webdriver-driver').NativeDiagnostic;
  const boundHosts = hosts as unknown as import('./host-collector').HostObservation[];
  const expected = Object.fromEntries(hosts.map(h => [h.hostId,h.binarySha256]));
  const result = normalizeBoundDiagnostics(diagnostic, boundHosts, expected);
  expect(result.provenance).toBe('normalized-unattested-diagnostic');
  expect(result.directions).toHaveLength(2);
  expect(result.directions[0].samples.map(s => s.audioDelayMs)).toEqual([20,20,20]);
  endpoints[0].probeNonce = 'f'.repeat(64);
  expect(() => normalizeBoundDiagnostics(diagnostic, boundHosts, expected)).toThrow('mismatch');
});
