/** Public, versioned fixtures. Never use meeting content for validation. */
import { createHash } from 'node:crypto';

export const FIXTURE_VERSION = 'hq-meet-public-v1';
export const SPEECH_SCRIPT = [
  'The blue notebook is beside the window.',
  'Seven small boats crossed the quiet lake.',
  'Please write the number forty two on the page.',
  'A clear voice helps everyone follow the conversation.',
  'The next screen shows a simple table of colors.',
].join('\n');
export const SCREEN_LINES = [
  'HQ Meet public screen fixture — version 1',
  'Reference text: fourteen point at normal fit view.',
  'Amber 17 | Indigo 42 | Silver 86 | Violet 93',
  'The quick brown fox jumps over the lazy dog.',
  '0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ',
];
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export const fixtureManifest = Object.freeze({
  version: FIXTURE_VERSION,
  speechScriptSha256: sha256(SPEECH_SCRIPT),
  screenTextSha256: sha256(SCREEN_LINES.join('\n')),
  screenFontPt: 14,
  screenWidth: 1280,
  screenHeight: 720,
});

/** A bounded stream, independent of platform PRNG and without a 100 MB allocation. */
export function* fileFixture(sizeBytes = 100_000_000): Generator<Uint8Array> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 100_000_000) {
    throw new Error('file fixture must contain 1..100000000 bytes');
  }
  for (let offset = 0; offset < sizeBytes; offset += 65536) {
    const chunk = new Uint8Array(Math.min(65536, sizeBytes - offset));
    for (let i = 0; i < chunk.length; i++) chunk[i] = ((offset + i) * 31 + 17) & 255;
    yield chunk;
  }
}
export function fileFixtureHash(sizeBytes = 100_000_000): string {
  const hash = createHash('sha256');
  for (const chunk of fileFixture(sizeBytes)) hash.update(chunk);
  return hash.digest('hex');
}
export type Profile = 'direct' | 'forced-turn' | 'constrained' | 'sleep-reconnect';
export const profiles = Object.freeze({
  direct: { iceTransportPolicy: 'all', uploadMbps: 10, downloadMbps: 30, rttMs: 80, lossPercent: 1, jitterMs: 0 },
  'forced-turn': { iceTransportPolicy: 'relay', uploadMbps: 10, downloadMbps: 30, rttMs: 80, lossPercent: 1, jitterMs: 0 },
  constrained: { iceTransportPolicy: 'all', uploadMbps: 2, downloadMbps: 10, rttMs: 150, lossPercent: 2, jitterMs: 30 },
  'sleep-reconnect': { iceTransportPolicy: 'all', uploadMbps: 10, downloadMbps: 30, rttMs: 80, lossPercent: 1, jitterMs: 0 },
} as const);
export const scenarios = ([2, 4, 8] as const).flatMap(participants =>
  (Object.keys(profiles) as Profile[]).map(profile => ({ participants, profile, durationMs: 60_000 })),
);
