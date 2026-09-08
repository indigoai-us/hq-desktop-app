/** Browser/media boundaries are mocked here. These regressions are NOT native certification. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
async function fixture(options: { suspended?: boolean; skipStart?: boolean } = {}) {
  let button: any, gesture = false;
  const timers = new Map<number, () => void>();
  let time = 0, video = 1, audio = 1, silent = false;
  const pcs: any[] = [];
  const track = { id: 'camera', stop() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const node = () => ({ connect() {}, start() {}, stop() {} });
  const canvasContext = { fillRect() {}, fillText() {}, drawImage() {},
    getImageData(x: number) { return { data: video & (1 << ((x - 20) / 24)) ? [255,255,255,255] : [0,0,0,255] }; } };
  const element = () => ({ style: {}, append() {}, remove() {}, play: async () => {},
    readyState: 2, videoWidth: 1280, videoHeight: 720,
    getContext: () => canvasContext, captureStream: () => stream });
  class AudioContext {
    state = options.suspended ? 'suspended' : 'running'; onstatechange?: () => void; currentTime = 0; sampleRate = 48000;
    resume = async () => { if (!options.suspended || gesture) { this.state = 'running'; this.onstatechange?.(); } }; close = async () => {};
    createMediaStreamSource = node;
    createAnalyser() { return { fftSize: 2048, frequencyBinCount: 1024,
      getFloatFrequencyData(bins: Float32Array) {
        bins.fill(-Infinity);
        if (!silent) for (let bank = 0; bank < 4; bank++) bins[Math.round((700 + bank * 3000 + ((audio >> (bank * 4)) & 15) * 150) * 2048 / 48000)] = -20;
      } }; }
    createMediaStreamDestination = () => ({ stream });
    decodeAudioData = async () => ({ duration: 10 });
    createBufferSource = node;
    createOscillator = () => ({ ...node(), frequency: { setValueAtTime() {} } });
    createGain = () => ({ ...node(), gain: { value: 0 } });
  }
  class Peer {
    iceGatheringState = 'gathering'; connectionState = 'connected'; iceConnectionState = 'connected';
    onicecandidate: any; receivedCandidates: unknown[] = [];
    localDescription = { toJSON: () => ({ type: 'offer' }) };
    ontrack: any;
    constructor() { pcs.push(this); }
    createDataChannel = () => ({ label: 'hq-public-file-v1', readyState: 'open', close() {} });
    addTrack() {} close() {}
    createOffer = async () => ({}); setLocalDescription = async () => {
      for (let i=0;i<16;i++) this.onicecandidate({candidate:{toJSON:()=>({candidate:`candidate:PRIVATE_ADDRESS_${i}`})}});
    };
    addIceCandidate = async (candidate: unknown) => { this.receivedCandidates.push(candidate); };
    getStats = async () => new Map<string, any>([
      ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.1 }],
      ['local', { candidateType: 'relay', address: 'PRIVATE_ADDRESS' }],
      ['remote', { candidateType: 'host' }],
      ['audio', { type: 'inbound-rtp', kind: 'audio', totalSamplesReceived: time * 48 }],
    ]);
  }
  const world: any = { performance: { now: () => time }, Date, Float32Array, Uint8Array,
    setTimeout: (callback: () => void, ms: number) => { timers.set(ms, callback); return ms; }, clearTimeout(ms: number) { timers.delete(ms); }, setInterval: () => 2, clearInterval() {},
    atob: () => '', AudioContext, RTCPeerConnection: Peer,
    MediaStream: class { constructor(_: unknown) {} },
    document: { createElement: (tag: string) => { const el = element(); if(tag==='button') button=el; return el; }, head: { append() {} }, body: { append() {} } },
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('physical capture unavailable'); } } } };
  runInNewContext(readFileSync(new URL('./native-probe.js', import.meta.url), 'utf8'), world);
  const probe = world.__hqMeetProbe;
  const result = { probe, world, pcs,
    start: () => probe.start({ speechBase64: '', screenLines: ['a','b','c','d','e'], durationMs: 30000 }),
    activate: () => { gesture = true; button.onclick(); }, expireAudio: () => timers.get(10000)!(),
    set(t: number, v: number, a: number, quiet = false) { time = t; video = v; audio = a; silent = quiet; },
    sample: async () => (await probe.snapshot()).peers[0] };
  if (options.skipStart || options.suspended) return result;
  await result.start();
  await probe.offer('remote', {});
  pcs[0].ontrack({ track: { id: 'remote-camera', kind: 'video' } });
  pcs[0].ontrack({ track: { id: 'remote-audio', kind: 'audio' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  return result;
}
describe('US-012 executable probe regressions (not native evidence)', () => {
  it('runs generated fixtures without physical devices and does not claim capture permission proof', async () => {
    const f = await fixture(); const snapshot = await f.probe.snapshot();
    expect(snapshot.physicalCaptureTested).toBe(false);
    expect(snapshot.captureSource).toBe('generated-public-fixtures');
    await f.probe.stop();
  });
  it('decodes actual pixel input for camera-only directions', async () => {
    const f = await fixture(); const s = await f.sample();
    expect(s.videoMarker).toEqual({ sequence: 1, width: 1280, height: 720, source: 'camera' });
    expect(s.receivedVideoMarkers).toBe(1); await f.probe.stop();
  });
  it('does not count frozen markers as progress even when RTC counters rise', async () => {
    const f = await fixture(); await f.sample(); f.set(2500, 1, 1);
    const s = await f.sample();
    expect(s.receivedVideoMarkers).toBe(1); expect(s.receivedAudioMarkers).toBe(1);
    expect(s.audioGapMs).toBe(2500);
    expect(s.rtc.find((r: any) => r.type === 'inbound-rtp').totalSamplesReceived).toBe(120000);
    f.set(3000, 2, 2); const recovered = await f.sample();
    expect(recovered.receivedVideoMarkers).toBe(2); expect(recovered.receivedAudioMarkers).toBe(2);
    expect(recovered.audioGapMs).toBe(3000);
    await f.probe.stop();
  });
  it('observes silence independently and projects candidate type without addresses', async () => {
    const f = await fixture(); await f.sample(); f.set(2501, 2, 2, true); const s = await f.sample();
    expect(s.audioGapMs).toBe(2501); expect(s.audioMarker).toBeNull(); expect(s.receivedAudioMarkers).toBe(1); expect(s.receivedVideoMarkers).toBe(2);
    expect(s.rtc[0]).toEqual({ type: 'selected-path', localCandidate: 'relay', remoteCandidate: 'host', rttSeconds: 0.1 });
    expect(JSON.stringify(s)).not.toContain('PRIVATE_ADDRESS'); await f.probe.stop();
  });
  it('decodes full audio sequence after multiple former eight-second cycles', async () => {
    const f = await fixture(); f.set(10100, 20, 20); const s = await f.sample();
    expect(s.audioMarker.sequence).toBe(20);
    f.set(10600, 21, 21); expect((await f.sample()).audioMarker.sequence).toBe(21);
    await f.probe.stop();
  });
  it('stops and removes its API when the collection window expires', async () => {
    const f = await fixture(); f.set(3600001, 1, 1);
    await expect(f.probe.snapshot()).rejects.toThrow('duration exceeded');
    expect(f.world.__hqMeetProbe).toBeUndefined();
  });
});

it('keeps start pending until a real activation and fails a bounded unactivated wait', async () => {
  const f = await fixture({suspended:true}); let completed = false;
  const started = f.start().then(()=>{completed=true;});
  await Promise.resolve(); expect(completed).toBe(false);
  f.activate(); await started; expect(completed).toBe(true); await f.probe.stop();
  const g = await fixture({suspended:true}); const denied = g.start();
  const rejected = expect(denied).rejects.toThrow('gesture timed out'); g.expireAudio(); await rejected; await g.probe.stop();
});
it('can stop before start and cancel an outstanding gesture wait', async () => {
  const f = await fixture({skipStart:true}); await expect(f.probe.stop()).resolves.toBeUndefined();
  expect(f.world.__hqMeetProbe).toBeUndefined();
  const g = await fixture({suspended:true}); const pending = g.start();
  const rejected = expect(pending).rejects.toThrow('gesture cancelled'); await g.probe.stop(); await rejected;
});
it('returns SDP while gathering continues and drains actual queued candidates once', async () => {
  const f = await fixture(); expect(f.pcs[0].iceGatheringState).toBe('gathering');
  const candidates = f.probe.drainIce('remote'); expect(candidates).toHaveLength(16);
  expect(f.probe.drainIce('remote')).toEqual([]);
  await f.probe.addIce('remote',candidates); expect(f.pcs[0].receivedCandidates).toHaveLength(16);
  expect(f.probe.connection('remote')).toMatchObject({state:'connected',channelState:'open'});
  expect(JSON.stringify(await f.sample())).not.toContain('PRIVATE_ADDRESS'); await f.probe.stop();
});
