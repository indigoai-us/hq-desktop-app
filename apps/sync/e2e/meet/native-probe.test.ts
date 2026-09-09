/** Browser/media boundaries are mocked here. These regressions are NOT native certification. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
async function fixture(options: { suspended?: boolean; skipStart?: boolean } = {}) {
  let button: any, gesture = false;
  const timers = new Map<number, () => void>();
  let injectedAudioFrame: number | undefined;
  let frameCallback: () => void = () => {}, frameInterval = Infinity;
  let observationCallback: () => void = () => {};
  let time = 0, video = 1, audio = 1, silent = false, ticking = false, corrupt = false;
  const pcs: any[] = [];
  const analysers: any[] = [];
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
    createAnalyser() { const analyser = { smoothingTimeConstant: 0.8, fftSize: 2048, get frequencyBinCount() { return this.fftSize / 2; },
      getFloatFrequencyData(bins: Float32Array) {
        bins.fill(-Infinity);
        const checksums: Record<number,number>={0: 7439, 1: 3374, 2: 15693, 15: 60640, 16: 3902, 20: 20410, 21: 24475, 99: 16842};
        const frame = injectedAudioFrame ?? (audio | ((checksums[audio] ^ (corrupt ? 1 : 0)) << 16));
        if (!silent) for (let bank = 0; bank < 8; bank++) bins[Math.round((500 + bank * 900 + ((frame >>> (bank * 4)) & 15) * 50) * this.fftSize / 48000)] = -20;
      } }; analysers.push(analyser); return analyser; }
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
  const world: any = { performance: { now: () => ticking ? time++ : time }, Date, Float32Array, Uint8Array,
    setTimeout: (callback: () => void, ms: number) => { timers.set(ms, callback); return ms; }, clearTimeout(ms: number) { timers.delete(ms); }, setInterval: (callback: () => void, ms: number) => { if(ms===100) observationCallback=callback; else { frameCallback=callback; frameInterval=ms; } return ms; }, clearInterval() {},
    atob: () => '', AudioContext, RTCPeerConnection: Peer,
    MediaStream: class { constructor(_: unknown) {} },
    document: { createElement: (tag: string) => { const el = element(); if(tag==='button') button=el; return el; }, head: { append() {} }, body: { append() {} } },
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('physical capture unavailable'); } } } };
  runInNewContext(readFileSync(new URL('./native-probe.js', import.meta.url), 'utf8'), world);
  const probe = world.__hqMeetProbe;
  const result = { probe, world, pcs, analysers,
    tickClock: () => { ticking=true; },
    rawAudioFrame: (value: number | undefined) => { injectedAudioFrame=value; },
    corrupt: (value: boolean) => { corrupt=value; },
    signal: (v: number, a: number) => { video=v; audio=a; },
    observe: (t: number) => { time=t; observationCallback(); },
    frameInterval: () => frameInterval, frame: (t: number) => { time=t; frameCallback(); },
    start: () => probe.start({ speechBase64: '', screenLines: ['a','b','c','d','e'], durationMs: 30000 }),
    activate: () => { gesture = true; button.onclick(); }, expireAudio: () => timers.get(10000)!(),
    set(t: number, v: number, a: number, quiet = false) { time = t; video = v; audio = a; silent = quiet; observationCallback(); },
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

it('paints at the requested video cadence while emitting each half-second marker only once', async () => {
  const f = await fixture();
  expect(f.frameInterval()).toBeLessThanOrEqual(1000/15);
  for (let i=1;i<15;i++) f.frame(i*1000/15);
  const snapshot=await f.probe.snapshot();
  expect(snapshot.emissions.map((e: any)=>e.sequence)).toEqual([0,1]);
  await f.probe.stop();
});

it('reads current audio frequency banks without averaging prior marker sequences', async () => {
  const f=await fixture();
  expect(f.analysers).toHaveLength(1);
  expect(f.analysers[0].smoothingTimeConstant).toBe(0);
  f.set(100, 15, 15); expect((await f.sample()).audioMarker.sequence).toBe(15);
  f.set(600, 16, 16); expect((await f.sample()).audioMarker.sequence).toBe(16);
  await f.probe.stop();
});

it('buffers actual local observations across slow controller polls and drains once', async () => {
  const f=await fixture();
  f.observe(100); f.observe(100); f.observe(200); f.observe(300);
  const s=await f.sample();
  expect(s.observations.map((o: any)=>o.atMs)).toEqual([100,200,300]);
  f.signal(99,99);
  const poll=await f.sample();
  expect(poll.observations).toEqual([]);
  expect(poll.audioMarker.sequence).toBe(1);
  for(let i=0;i<601;i++) f.observe(400+i*100);
  await expect(f.sample()).rejects.toThrow('observation buffer exhausted');
  await f.probe.stop();
});

it('timestamps the drain after its initial native observation with a moving clock', async () => {
  const f=await fixture();f.tickClock();
  const s=await f.probe.snapshot();
  expect(s.peers[0].observations).toHaveLength(1);
  expect(s.peers[0].observations[0].atMs).toBeLessThanOrEqual(s.atMs);
  await f.probe.stop();
});

it('records invalid audio checksums without guessing a marker or erasing the observation', async () => {
  const f=await fixture();f.set(100,15,15);
  expect((await f.sample()).audioMarker.sequence).toBe(15);
  f.corrupt(true);f.set(600,16,16);
  const bad=await f.sample();
  expect(bad.audioMarker).toBeNull();
  expect(bad.audioDecode.status).toBe('checksum-mismatch');
  expect(bad.observations.at(-1).audioDecode).toEqual(bad.audioDecode);
  expect(bad.receivedAudioMarkers).toBe(1);
  f.corrupt(false);f.set(1100,16,16);
  expect((await f.sample()).audioMarker.sequence).toBe(16);
  await f.probe.stop();
});

it('rejects every single-bit corrupted frame and never invents a sequence during adjacent-symbol overlap', async () => {
  const f=await fixture();const valid=1|(3374<<16);let t=100;
  for(let bit=0;bit<32;bit++){
    f.rawAudioFrame(valid^(1<<bit));f.set(t+=100,1,1);
    const s=await f.sample();expect(s.audioMarker).toBeNull();expect(s.audioDecode.status).toBe('checksum-mismatch');
  }
  const before=15|(60640<<16),after=16|(3902<<16);
  for(let mask=0;mask<256;mask++){
    let mixed=0;for(let bank=0;bank<8;bank++) mixed|=(((mask&(1<<bank)?after:before) >>> (4*bank))&15)<<(4*bank);
    f.rawAudioFrame(mixed);f.set(t+=100,1,1);const s=await f.sample();
    if(s.audioMarker)expect([15,16]).toContain(s.audioMarker.sequence);
    else expect(s.audioDecode.status).toBe('checksum-mismatch');
  }
  await f.probe.stop();
});
