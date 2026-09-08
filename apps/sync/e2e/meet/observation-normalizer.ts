/** Converts raw probe observations to measurements, never an attested native receipt. */
export interface ClockExchange { requestStartedMs: number; responseReceivedMs: number; remoteAtMs: number }
export interface Calibration { offsetMs: number; uncertaintyMs: number }
const finite = (n: number) => Number.isFinite(n);
export function calibrateClock(exchanges: ClockExchange[]): Calibration {
  if (exchanges.length < 3 || exchanges.length > 36001) throw new Error('clock needs bounded repeated observations');
  let lower = -Infinity, upper = Infinity;
  for (const e of exchanges) {
    if (![e.requestStartedMs, e.responseReceivedMs, e.remoteAtMs].every(finite) ||
        e.requestStartedMs < 0 || e.remoteAtMs < 0 || e.responseReceivedMs < e.requestStartedMs) throw new Error('invalid clock exchange');
    lower = Math.max(lower, e.requestStartedMs - e.remoteAtMs);
    upper = Math.min(upper, e.responseReceivedMs - e.remoteAtMs);
  }
  if (lower > upper) throw new Error('clock drift or inconsistent observations');
  if (upper - lower > 100) throw new Error('clock uncertainty exceeds 50ms');
  return { offsetMs: (lower + upper) / 2, uncertaintyMs: (upper - lower) / 2 };
}
export interface Emission { atMs: number; sequence: number }
export interface Observation { atMs: number; audioMarker: { sequenceModulo16: number } | null; videoMarker: { sequence: number } | null }
export function normalizeMarkers(options: { emissions: Emission[]; observations: Observation[];
  sourceClock: Calibration; receiverClock: Calibration }) {
  const { emissions, observations, sourceClock, receiverClock } = options;
  for (const clock of [sourceClock, receiverClock]) if (!finite(clock.offsetMs) || !finite(clock.uncertaintyMs) || clock.uncertaintyMs < 0 || clock.uncertaintyMs > 50) throw new Error('invalid calibration');
  if (!emissions.length || emissions.length > 7201 || !observations.length || observations.length > 36001) throw new Error('invalid bounded marker observations');
  for (let i = 0; i < emissions.length; i++) {
    const e = emissions[i];
    if (!finite(e.atMs) || e.atMs < 0 || !Number.isInteger(e.sequence) || e.sequence < 0 || e.sequence > 65535 ||
      (i && (e.atMs <= emissions[i - 1].atMs || e.sequence <= emissions[i - 1].sequence))) throw new Error('invalid ordered emissions');
  }
  const uncertaintyMs = sourceClock.uncertaintyMs + receiverClock.uncertaintyMs;
  let audio: Emission | undefined, video: Emission | undefined, lastProgress: number | undefined;
  return observations.map((o, i) => {
    if (!finite(o.atMs) || o.atMs < 0 || (i && (o.atMs <= observations[i - 1].atMs || o.atMs - observations[i - 1].atMs > 1000))) throw new Error('missing or unordered receiver observations');
    const atMs = o.atMs + receiverClock.offsetMs;
    if (lastProgress === undefined) lastProgress = atMs;
    const match = (sequence: number, previous: Emission | undefined, modulo: boolean): Emission => {
      if (!Number.isInteger(sequence) || sequence < 0 || sequence > (modulo ? 15 : 65535)) throw new Error('invalid received marker');
      if (previous && (modulo ? previous.sequence % 16 : previous.sequence) === sequence) return previous;
      const candidates = emissions.filter(e => (modulo ? e.sequence % 16 : e.sequence) === sequence &&
        (!previous || e.sequence > previous.sequence) && e.atMs + sourceClock.offsetMs <= atMs + uncertaintyMs);
      if (candidates.length !== 1) throw new Error('ambiguous or unmatched received marker');
      return candidates[0];
    };
    const audioGapMs = atMs - lastProgress;
    let audioChanged = false, videoChanged = false;
    if (o.audioMarker) {
      const next = match(o.audioMarker.sequenceModulo16, audio, true);
      if (next !== audio) { lastProgress = atMs; audioChanged = true; }
      audio = next;
    }
    if (o.videoMarker) { const next = match(o.videoMarker.sequence, video, false); videoChanged = next !== video; video = next; }
    const delay = (emission: Emission | undefined, present: boolean) => emission && present ?
      Math.max(0, atMs - emission.atMs - sourceClock.offsetMs) : null;
    return { atMs, audioDelayMs: delay(audio, audioChanged),
      videoDelayMs: delay(video, videoChanged), clockUncertaintyMs: uncertaintyMs,
      audioGapMs, audioSequence: audio?.sequence ?? null, videoSequence: video?.sequence ?? null };
  });
}
export interface SessionBinding { hostId: string; pid: number; binarySha256: string; sessionId: string; probeNonce: string; webdriverUrl: string }
/** Compare independently collected host binding with the attached probe identity. */
export function verifySessionBindings(hosts: SessionBinding[], probes: Pick<SessionBinding, 'sessionId' | 'webdriverUrl' | 'probeNonce'>[], expectedBinaries: Record<string, string>): void {
  if (![2,4,8].includes(hosts.length) || hosts.length !== probes.length) throw new Error('missing host/session binding');
  const seen = new Set<string>(), sessions = new Set<string>();
  if (new Set(probes.map(p => `${p.webdriverUrl}/${p.sessionId}`)).size !== probes.length) throw new Error('duplicate probe session');
  for (const host of hosts) {
    if (!/^[a-f0-9]{64}$/.test(host.hostId) || !/^[a-f0-9]{64}$/.test(host.binarySha256) ||
        !Number.isSafeInteger(host.pid) || host.pid < 1 || !/^[a-f0-9]{64}$/.test(host.probeNonce)) throw new Error('invalid host binding');
    if (expectedBinaries[host.hostId] !== host.binarySha256) throw new Error('unexpected host binary hash');
    if (seen.has(host.hostId)) throw new Error('duplicate actual host');
    seen.add(host.hostId);
    const sessionKey = `${host.webdriverUrl}/${host.sessionId}`;
    if (sessions.has(sessionKey)) throw new Error('duplicate host session');
    sessions.add(sessionKey);
    const matching = probes.filter(p => p.webdriverUrl === host.webdriverUrl && p.sessionId === host.sessionId);
    if (matching.length !== 1 || matching[0].probeNonce !== host.probeNonce) throw new Error('host/probe session binding mismatch');
  }
}

/** Raw clock/marker normalization remains diagnostic; signing is a separate trust boundary. */
export function normalizeDiagnostics(diagnostic: import('./webdriver-driver').NativeDiagnostic) {
  const endpoints = diagnostic.endpoints;
  if (![2,4,8].includes(endpoints.length) || new Set(endpoints.map(e => e.id)).size !== endpoints.length) throw new Error('invalid endpoint set');
  const raw = endpoints.map(endpoint => {
    const samples = endpoint.samples as { requestStartedMs?: number; responseReceivedMs: number; snapshot: {
      atMs: number; emissions: Emission[]; peers: (Observation & { peerId: string })[] } }[];
    const regular = samples.filter(s => s.requestStartedMs !== undefined);
    const clock = calibrateClock(regular.map(s => ({ requestStartedMs: s.requestStartedMs!, responseReceivedMs: s.responseReceivedMs, remoteAtMs: s.snapshot.atMs })));
    return { id: endpoint.id, clock, emissions: regular.flatMap(s => s.snapshot.emissions), samples: regular };
  });
  const directions = raw.flatMap(source => raw.filter(receiver => receiver !== source).map(receiver => ({
    from: source.id, to: receiver.id,
    samples: normalizeMarkers({ sourceClock: source.clock, receiverClock: receiver.clock, emissions: source.emissions,
      observations: receiver.samples.map(s => {
        const peers = s.snapshot.peers.filter(p => p.peerId === source.id);
        if (peers.length !== 1) throw new Error('missing or duplicate receiver direction');
        return peers[0];
      }) }),
  })));
  return { provenance: 'normalized-unattested-diagnostic' as const, clocks: raw.map(r => ({ id: r.id, ...r.clock })), directions };
}

export function normalizeBoundDiagnostics(diagnostic: import('./webdriver-driver').NativeDiagnostic,
  hosts: import('./host-collector').HostObservation[], expectedBinaries: Record<string, string>) {
  const bindings = hosts.map(host => {
    if (!host.sessionBinding || host.provenance !== 'native-os-commands' || !host.signature.valid) throw new Error('missing signed host/session observation');
    return { ...host.sessionBinding, hostId: host.hostId, pid: host.pid, binarySha256: host.binarySha256 };
  });
  const probes = diagnostic.endpoints.map(e => {
    if (!e.sessionId || !e.webdriverUrl || !e.probeNonce) throw new Error('missing probe identity');
    return { sessionId: e.sessionId, webdriverUrl: e.webdriverUrl, probeNonce: e.probeNonce };
  });
  verifySessionBindings(bindings, probes, expectedBinaries);
  return { ...normalizeDiagnostics(diagnostic), hosts: bindings };
}
