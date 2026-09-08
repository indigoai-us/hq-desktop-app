/** pnpm exec tsx apps/sync/e2e/meet/run-native.ts collect|verify ... */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectNativeDiagnostics } from './webdriver-driver';
import { verifyNativeEvidence } from './native-harness';
import { collectHost } from './host-collector';
import { generateFixtures } from './fixture-generator';
import { runLadder } from './ladder';
import { normalizeBoundDiagnostics } from './observation-normalizer';
import { type Profile } from './fixtures';

async function main(): Promise<void> {
  const [mode, configPath, outputPath] = process.argv.slice(2);
  if (!['collect', 'verify', 'host', 'fixtures', 'ladder', 'normalize'].includes(mode) || !configPath || !outputPath) throw new Error('usage: run-native.ts collect|verify|host|fixtures|ladder|normalize config.json output.json');
  const raw = await readFile(configPath, 'utf8');
  if (raw.length > 64_000) throw new Error('configuration exceeds size budget');
  const config = JSON.parse(raw);
  let result: unknown;
  if (mode === 'normalize') {
    const boundedJson = async (file: string) => {
      const bytes = await readFile(file);
      if (bytes.length > 32 * 1024 * 1024) throw new Error('observation byte budget exceeded');
      return JSON.parse(bytes.toString('utf8'));
    };
    result = normalizeBoundDiagnostics(await boundedJson(config.diagnosticPath),
      await boundedJson(config.hostObservationsPath), config.expectedBinaries);
  } else if (mode === 'host') {
    result = await collectHost(config);
  } else if (mode === 'fixtures') {
    result = await generateFixtures(config.directory, config.fileSizeBytes);
  } else if (mode === 'ladder') {
    const iceServers = process.env.HQ_MEET_TEST_ICE_SERVERS ? JSON.parse(process.env.HQ_MEET_TEST_ICE_SERVERS) : undefined;
    result = await runLadder({ endpoints: config.endpoints, outputDirectory: config.outputDirectory,
      networkScope: config.networkScope, durationMs: config.durationMs, fileSizeBytes: config.fileSizeBytes, speechWav: await readFile(config.speechWavPath), iceServers });
  } else if (mode === 'collect') {
    // Secret value never enters the persisted config or output. Resolve through hq secrets exec.
    const iceServers = process.env.HQ_MEET_TEST_ICE_SERVERS ? JSON.parse(process.env.HQ_MEET_TEST_ICE_SERVERS) : undefined;
    result = await collectNativeDiagnostics({ endpoints: config.endpoints, profile: config.profile as Profile,
      networkScope: config.networkScope, durationMs: config.durationMs, fileSizeBytes: config.fileSizeBytes, speechWav: await readFile(config.speechWavPath), iceServers,
      onProbeStarted: config.bindingDirectory ? async binding => {
        await mkdir(resolve(config.bindingDirectory), { recursive: true });
        await writeFile(resolve(config.bindingDirectory, `${binding.id}.json`), JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
      } : undefined });
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
