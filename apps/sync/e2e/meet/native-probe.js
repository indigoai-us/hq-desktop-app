/* Test-only injection into an attached native WebView. No app auth/signing/TCC bypass.
 * This deliberately has no Node APIs, dependency on Meet UI, or fallback mock.
 * SDP and ICE credentials are held only in live peer objects, never snapshots.
 */
(() => {
  'use strict';
  if (globalThis.__hqMeetProbe) throw new Error('probe already installed');
  let context, microphone, camera, fixtureAudio, screenStream, oscillator, canvas, timer;
  let surface, mask, watchdog;
  let start = 0, stopped = false, sequence = 0, emitted = [], peers = new Map();
  const now = () => performance.now() - start;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const candidate = value => ['host', 'srflx', 'prflx', 'relay'].includes(value) ? value : 'unknown';
  const waitGathering = pc => new Promise((resolve, reject) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timeout = setTimeout(() => { pc.removeEventListener('icegatheringstatechange', changed); reject(new Error('ICE gathering timeout')); }, 10000);
    const changed = () => {
      if (pc.iceGatheringState !== 'complete') return;
      clearTimeout(timeout); pc.removeEventListener('icegatheringstatechange', changed); resolve();
    };
    pc.addEventListener('icegatheringstatechange', changed);
  });
  function render() {
    const c = canvas.getContext('2d');
    sequence = Math.floor(now() / 500) % 65536;
    c.fillStyle = 'white'; c.fillRect(0, 0, 1280, 720);
    for (let bit = 0; bit < 16; bit++) {
      c.fillStyle = sequence & (1 << bit) ? 'white' : 'black';
      c.fillRect(10 + bit * 24, 10, 20, 30);
    }
    c.fillStyle = '#111'; c.font = '14pt Arial';
    globalThis.__hqMeetProbe.screenLines.forEach((line, i) => c.fillText(line, 30, 90 + i * 34));
    // Distinct public frequency marker mixed with the public speech fixture.
    oscillator.frequency.setValueAtTime(700 + (sequence % 16) * 150, context.currentTime);
    emitted.push({ atMs: now(), sequence, audioContextSeconds: context.currentTime });
    if (emitted.length > 7201) throw new Error('probe emission budget exhausted');
  }
  async function receive(peer, event) {
    const track = event.track;
    const stream = new MediaStream([track]);
    if (track.kind === 'audio') {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      source.connect(analyser);
      // Playback follows real autoplay/user-gesture policy: rejection is a failure.
      const audio = document.createElement('audio'); audio.srcObject = stream; audio.autoplay = true;
      surface.append(audio); peer.elements.push(audio);
      await audio.play();
      peer.audio = analyser;
    } else {
      const video = document.createElement('video'); video.srcObject = stream; video.autoplay = true;
      video.muted = true; video.playsInline = true; video.style.width = '640px';
      surface.append(video); peer.elements.push(video); await video.play();
      // Screen track is identified by the metadata accompanying the actual SDP.
      if (track.id === peer.remoteScreenTrackId) peer.screen = video;
      else peer.camera = video;
    }
  }
  async function connect(id, configuration, remote) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || peers.has(id) || peers.size >= 7) throw new Error('invalid peer');
    const pc = new RTCPeerConnection(configuration);
    const peer = { pc, elements: [], errors: [], remoteScreenTrackId: remote?.screenTrackId,
      audioCount: 0, videoCount: 0, samples: [], decodedCanvas: document.createElement('canvas') };
    peer.decodedCanvas.width = 1280; peer.decodedCanvas.height = 720;
    peers.set(id, peer);
    pc.ontrack = event => { receive(peer, event).catch(() => peer.errors.push('receiver-playback-failed')); };
    fixtureAudio.getTracks().forEach(track => pc.addTrack(track, fixtureAudio));
    camera.getVideoTracks().forEach(track => pc.addTrack(track, camera));
    screenStream?.getTracks().forEach(track => pc.addTrack(track, screenStream));
    if (remote) {
      await pc.setRemoteDescription(remote.description);
      await pc.setLocalDescription(await pc.createAnswer());
    } else await pc.setLocalDescription(await pc.createOffer());
    await waitGathering(pc);
    return { description: pc.localDescription.toJSON(), screenTrackId: screenStream?.getVideoTracks()[0]?.id };
  }
  async function sample(id, peer) {
    const atMs = now();
    const value = { peerId: id, atMs, connectionState: peer.pc.connectionState,
      receivedAudioMarkers: peer.audioCount, receivedVideoMarkers: peer.videoCount,
      audioMarker: null, videoMarker: null, rtc: [], errors: [...peer.errors] };
    if (peer.audio) {
      const bins = new Float32Array(peer.audio.frequencyBinCount); peer.audio.getFloatFrequencyData(bins);
      let best = -Infinity, marker = -1;
      for (let n = 0; n < 16; n++) {
        const bin = Math.round((700 + n * 150) * peer.audio.fftSize / context.sampleRate);
        const power = Math.max(bins[bin - 1], bins[bin], bins[bin + 1]);
        if (power > best) { best = power; marker = n; }
      }
      if (best > -45) {
        value.audioMarker = { sequenceModulo16: marker, levelDb: best };
        value.receivedAudioMarkers = ++peer.audioCount;
      }
    }
    if (peer.screen && peer.screen.readyState >= 2 && peer.screen.videoWidth === 1280) {
      const c = peer.decodedCanvas.getContext('2d', { willReadFrequently: true });
      c.drawImage(peer.screen, 0, 0, 1280, 720);
      let decoded = 0;
      for (let bit = 0; bit < 16; bit++) {
        const pixel = c.getImageData(20 + bit * 24, 20, 1, 1).data;
        if (pixel[0] + pixel[1] + pixel[2] > 384) decoded |= 1 << bit;
      }
      value.videoMarker = { sequence: decoded, width: peer.screen.videoWidth, height: peer.screen.videoHeight };
      value.receivedVideoMarkers = ++peer.videoCount;
    }
    const stats = await peer.pc.getStats();
    stats.forEach(s => {
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const pair = stats.get(s.selectedCandidatePairId);
        if (pair) value.rtc.push({ type: 'selected-path', localCandidate: candidate(stats.get(pair.localCandidateId)?.candidateType),
          remoteCandidate: candidate(stats.get(pair.remoteCandidateId)?.candidateType),
          rttSeconds: finite(pair.currentRoundTripTime) ? pair.currentRoundTripTime : null });
      }
      if (['inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp'].includes(s.type)) {
        const projected = { type: s.type, kind: ['audio', 'video'].includes(s.kind) ? s.kind : 'unknown' };
        for (const field of ['bytesReceived', 'bytesSent', 'packetsReceived', 'packetsSent', 'packetsLost',
          'jitter', 'framesDecoded', 'framesEncoded', 'totalSamplesReceived', 'concealedSamples',
          'jitterBufferDelay', 'jitterBufferEmittedCount', 'roundTripTime']) {
          if (finite(s[field])) projected[field] = s[field];
        }
        value.rtc.push(projected);
      }
    });
    return value;
  }
  globalThis.__hqMeetProbe = {
    screenLines: [],
    async start(options) {
      if (context || stopped) throw new Error('probe lifecycle cannot restart');
      if (!options || typeof options.speechBase64 !== 'string' || options.speechBase64.length > 16000000 ||
          !Array.isArray(options.screenLines) || options.screenLines.length !== 5) throw new Error('public speech/screen fixtures required');
      this.screenLines = options.screenLines;
      start = performance.now();
      mask = document.createElement('style');
      mask.textContent = 'body > :not(#hq-meet-probe-surface) { visibility: hidden !important; }';
      document.head.append(mask);
      surface = document.createElement('div'); surface.id = 'hq-meet-probe-surface';
      surface.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:white;color:black;overflow:auto;visibility:visible';
      document.body.append(surface);
      const activate = document.createElement('button'); activate.textContent = 'Enable public fixture audio';
      activate.onclick = () => { context?.resume(); }; surface.append(activate);
      watchdog = setTimeout(() => this.stop(), Math.min(3600000, options.durationMs || 60000) + 180000);
      context = new AudioContext(); await context.resume();
      if (context.state !== 'running') throw new Error('native user gesture required for audio');
      // Real native permission paths, with no fake-device flags. The microphone is
      // permission-tested but never sent or persisted: only public speech is sent.
      microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphone.getTracks().forEach(track => track.stop());
      const permissionCamera = await navigator.mediaDevices.getUserMedia({ video: true });
      permissionCamera.getTracks().forEach(track => track.stop());
      const destination = context.createMediaStreamDestination();
      const bytes = Uint8Array.from(atob(options.speechBase64), c => c.charCodeAt(0));
      const buffer = await context.decodeAudioData(bytes.buffer);
      if (buffer.duration < 5 || buffer.duration > 120) throw new Error('speech fixture must span 5..120 seconds');
      const speech = context.createBufferSource(); speech.buffer = buffer; speech.loop = true;
      speech.connect(destination); speech.start();
      oscillator = context.createOscillator(); const gain = context.createGain(); gain.gain.value = 0.08;
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      fixtureAudio = destination.stream;
      canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      canvas.style.width = '640px'; surface.append(canvas);
      camera = canvas.captureStream(15);
      if (options.shareScreen) screenStream = canvas.captureStream(15); render(); timer = setInterval(render, 500);
      return { provenance: 'native-probe-unattested', wallTimeMs: Date.now(), monotonicMs: performance.now(),
        audioState: context.state, screenTrack: Boolean(screenStream?.getVideoTracks().length) };
    },
    offer(id, configuration) { return connect(id, configuration); },
    answer(id, configuration, remote) { return connect(id, configuration, remote); },
    async acceptAnswer(id, answer) {
      const peer = peers.get(id); if (!peer) throw new Error('unknown peer');
      peer.remoteScreenTrackId = answer.screenTrackId;
      await peer.pc.setRemoteDescription(answer.description);
    },
    async snapshot() {
      if (!context || stopped) throw new Error('probe is not running');
      if (now() > 3600000) { await this.stop(); throw new Error('probe duration exceeded'); }
      return { provenance: 'native-probe-unattested', atMs: now(), wallTimeMs: Date.now(),
        emissions: emitted.splice(0), peers: await Promise.all([...peers].map(([id, peer]) => sample(id, peer))) };
    },
    async stop() {
      stopped = true; clearInterval(timer); clearTimeout(watchdog);
      for (const peer of peers.values()) { peer.pc.close(); peer.elements.forEach(element => element.remove()); }
      for (const stream of [microphone, camera, fixtureAudio, screenStream]) stream?.getTracks().forEach(track => track.stop());
      oscillator?.stop(); await context?.close(); canvas?.remove(); surface?.remove(); mask?.remove(); peers.clear();
      delete globalThis.__hqMeetProbe;
    },
  };
})();
