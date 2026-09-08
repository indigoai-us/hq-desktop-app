import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { collectNativeDiagnostics, parseEndpoints, type NativeDiagnostic } from './webdriver-driver';
import { scenarios } from './fixtures';

export interface LadderResult {
  schema: 'hq-meet-native-ladder/v1'; provenance: 'diagnostic-only';
  completed: { participants: number; profile: string; artifact: string }[];
}
/** Executes the entire declared ladder; earlier artifacts survive a later failure. */
export async function runLadder(options: {
  endpoints: unknown; speechWav: Uint8Array; outputDirectory: string; durationMs?: number;
  fileSizeBytes?: number; iceServers?: RTCIceServer[]; signal?: AbortSignal;
}, collect: typeof collectNativeDiagnostics = collectNativeDiagnostics): Promise<LadderResult> {
  const endpoints = parseEndpoints(options.endpoints);
  if (endpoints.length !== 8 || !isAbsolute(options.outputDirectory)) throw new Error('full ladder requires eight native endpoints and absolute output directory');
  await mkdir(options.outputDirectory, { recursive: false, mode: 0o700 });
  const result: LadderResult = { schema: 'hq-meet-native-ladder/v1', provenance: 'diagnostic-only', completed: [] };
  for (const scenario of scenarios) {
    if (options.signal?.aborted) throw new Error('native ladder cancelled');
    const artifact = `${scenario.participants}-${scenario.profile}.json`;
    const diagnostic: NativeDiagnostic = await collect({ endpoints: endpoints.slice(0, scenario.participants),
      profile: scenario.profile, durationMs: options.durationMs ?? scenario.durationMs,
      speechWav: options.speechWav, fileSizeBytes: options.fileSizeBytes,
      iceServers: options.iceServers, signal: options.signal });
    await writeFile(join(options.outputDirectory, artifact), `${JSON.stringify(diagnostic)}\n`, { flag: 'wx', mode: 0o600 });
    result.completed.push({ participants: scenario.participants, profile: scenario.profile, artifact });
  }
  await writeFile(join(options.outputDirectory, 'ladder.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return result;
}
