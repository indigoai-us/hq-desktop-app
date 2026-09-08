/** pnpm exec tsx apps/sync/e2e/meet/run-native.ts collect|verify ... */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectNativeDiagnostics } from './webdriver-driver';
import { verifyNativeEvidence } from './native-harness';
import { type Profile } from './fixtures';

async function main(): Promise<void> {
  const [mode, configPath, outputPath] = process.argv.slice(2);
  if (!['collect', 'verify'].includes(mode) || !configPath || !outputPath) throw new Error('usage: run-native.ts collect|verify config.json output.json');
  const raw = await readFile(configPath, 'utf8');
  if (raw.length > 64_000) throw new Error('configuration exceeds size budget');
  const config = JSON.parse(raw);
  let result: unknown;
  if (mode === 'collect') {
    // Secret value never enters the persisted config or output. Resolve through hq secrets exec.
    const iceServers = process.env.HQ_MEET_TEST_ICE_SERVERS ? JSON.parse(process.env.HQ_MEET_TEST_ICE_SERVERS) : undefined;
    result = await collectNativeDiagnostics({ endpoints: config.endpoints, profile: config.profile as Profile,
      durationMs: config.durationMs, speechWav: await readFile(config.speechWavPath), iceServers });
  } else {
    result = await verifyNativeEvidence({ root: config.evidenceRoot, evidencePath: config.evidencePath,
      signature: await readFile(config.signaturePath), trustedPublicKeyPem: await readFile(config.trustedCollectorPublicKeyPath, 'utf8') });
  }
  // Exclusive creation prevents overwriting an earlier evidence receipt.
  await mkdir(resolve(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (mode === 'verify' && (result as { status: string }).status !== 'pass') process.exitCode = 1;
}
main().catch(() => { console.error('Meet native harness failed; no passing receipt was produced. Check configuration, native UI and collector artifacts.'); process.exitCode = 1; });
