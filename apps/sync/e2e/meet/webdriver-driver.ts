/** Concrete adapter for existing native WebDriver sessions. Never launches a browser. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SCREEN_LINES, profiles, sha256, type Profile } from './fixtures';

export interface Endpoint { id: string; webdriverUrl: string; sessionId: string }
export interface NativeDiagnostic {
  schema: 'hq-meet-native-diagnostic/v1'; provenance: 'unattested-native-probe';
  profile: Profile; durationMs: number; speechSha256: string;
  endpoints: { id: string; samples: unknown[]; screenshotPngBase64: string }[];
}
export function parseEndpoints(raw: unknown): Endpoint[] {
  if (!Array.isArray(raw) || ![2, 4, 8].includes(raw.length)) throw new Error('attach exactly 2, 4 or 8 native devices');
  const endpoints = raw.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('invalid endpoint');
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(e.id) ||
        typeof e.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(e.sessionId) ||
        typeof e.webdriverUrl !== 'string') throw new Error('invalid native endpoint');
    const url = new URL(e.webdriverUrl);
    // Use SSH/native runner tunnels for remote machines, never expose unauthenticated WebDriver.
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('WebDriver must be a loopback tunnel');
    return { id: e.id, sessionId: e.sessionId, webdriverUrl: url.origin };
  });
  if (new Set(endpoints.map(e => e.id)).size !== endpoints.length ||
      new Set(endpoints.map(e => `${e.webdriverUrl}/${e.sessionId}`)).size !== endpoints.length) throw new Error('duplicate native device/session');
  return endpoints;
}
class Driver {
  constructor(readonly endpoint: Endpoint, readonly signal: AbortSignal) {}
  async command(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.endpoint.webdriverUrl}/session/${this.endpoint.sessionId}${path}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]),
    });
    // Do not include response bodies: driver errors may echo SDP or ICE credentials.
    if (!response.ok) throw new Error(`native driver command failed (${response.status})`);
    const result = await response.json() as { value?: unknown };
    if (result.value && typeof result.value === 'object' && 'error' in result.value) throw new Error('native driver command rejected');
    return result.value;
  }
  async inject(source: string): Promise<void> { await this.command('POST', '/execute/sync', { script: source, args: [] }); }
  async call(method: string, ...args: unknown[]): Promise<unknown> {
    const result = await this.command('POST', '/execute/async', {
      script: `const done = arguments[arguments.length - 1];
        Promise.resolve().then(() => globalThis.__hqMeetProbe[arguments[0]](...arguments[1]))
        .then(value => done({ ok: true, value }), () => done({ ok: false }));`,
      args: [method, args],
    }) as { ok?: boolean; value?: unknown };
    if (!result?.ok) throw new Error('native probe operation failed; inspect native permission UI');
    return result.value;
  }
}

/** Collect actual remote tracks. Output remains diagnostic until independent host attestation. */
export async function collectNativeDiagnostics(options: {
  endpoints: unknown; profile: Profile; durationMs: number; speechWav: Uint8Array;
  iceServers?: RTCIceServer[]; signal?: AbortSignal;
}): Promise<NativeDiagnostic> {
  const endpoints = parseEndpoints(options.endpoints);
  if (!(options.profile in profiles) || !Number.isInteger(options.durationMs) || options.durationMs < 30_000 || options.durationMs > 3_600_000 ||
      options.speechWav.length < 44 || options.speechWav.length > 12_000_000) throw new Error('invalid bounded collection options');
  if (options.profile === 'forced-turn' && !options.iceServers?.length) throw new Error('forced TURN requires ephemeral authorized ICE servers');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), options.durationMs + 180_000);
  const drivers = endpoints.map(endpoint => new Driver(endpoint, signal));
  let collectedBytes = 0;
  const records = endpoints.map(e => ({ id: e.id, samples: [] as unknown[], screenshotPngBase64: '' }));
  try {
    const source = await readFile(fileURLToPath(new URL('./native-probe.js', import.meta.url)), 'utf8');
    for (const driver of drivers) {
      await driver.inject(source);
      await driver.command('POST', '/timeouts', { script: 15_000 });
      await driver.call('start', { durationMs: options.durationMs, shareScreen: driver === drivers[0], screenLines: SCREEN_LINES, speechBase64: Buffer.from(options.speechWav).toString('base64') });
    }
    const configuration: RTCConfiguration = { iceTransportPolicy: profiles[options.profile].iceTransportPolicy,
      iceServers: options.iceServers ?? [] };
    // Offer/answer and full ICE descriptions live only in this lexical scope.
    for (let i = 0; i < drivers.length; i++) for (let j = i + 1; j < drivers.length; j++) {
      const offer = await drivers[i].call('offer', endpoints[j].id, configuration);
      const answer = await drivers[j].call('answer', endpoints[i].id, configuration, offer);
      await drivers[i].call('acceptAnswer', endpoints[j].id, answer);
    }
    const start = performance.now();
    while (performance.now() - start < options.durationMs) {
      if (signal.aborted) throw new Error('native collection cancelled');
      await Promise.all(drivers.map(async (driver, i) => {
        const requestStartedMs = performance.now() - start;
        const snapshot = await driver.call('snapshot');
        collectedBytes += Buffer.byteLength(JSON.stringify(snapshot));
        if (collectedBytes > 32 * 1024 * 1024) throw new Error('diagnostic artifact byte budget exhausted');
        records[i].samples.push({ requestStartedMs, responseReceivedMs: performance.now() - start, snapshot });
      }));
      await new Promise<void>(resolve => setTimeout(resolve, 200));
    }
    for (let i = 0; i < drivers.length; i++) {
      const screenshot = await drivers[i].command('GET', '/screenshot');
      if (typeof screenshot !== 'string' || screenshot.length > 32_000_000 || !/^[A-Za-z0-9+/=]+$/.test(screenshot)) throw new Error('invalid native screenshot');
      collectedBytes += screenshot.length;
      if (collectedBytes > 32 * 1024 * 1024) throw new Error('diagnostic artifact byte budget exhausted');
      records[i].screenshotPngBase64 = screenshot;
    }
    return { schema: 'hq-meet-native-diagnostic/v1', provenance: 'unattested-native-probe',
      profile: options.profile, durationMs: options.durationMs, speechSha256: sha256(options.speechWav), endpoints: records };
  } finally {
    clearTimeout(timeout);
    // Cleanup gets a fresh bounded signal even if collection was cancelled.
    await Promise.allSettled(endpoints.map(e => new Driver(e, AbortSignal.timeout(5000)).call('stop')));
  }
}
