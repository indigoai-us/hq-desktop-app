import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { platform, release } from 'node:os';
import { SPEECH_SCRIPT, fileFixture, fileFixtureHash, fixtureManifest, sha256 } from './fixtures';
const exec = promisify(execFile);

/** Uses installed voices only; never downloads voices, installs engines or uses private text. */
export async function generateFixtures(directory: string, fileSizeBytes = 1_000_000): Promise<Record<string, unknown>> {
  if (!isAbsolute(directory)) throw new Error('fixture directory must be absolute');
  // An exclusive directory avoids overwriting earlier fixture provenance.
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const speechText = join(directory, 'speech.txt'), wavPath = join(directory, 'speech.wav');
  await writeFile(speechText, SPEECH_SCRIPT, { flag: 'wx', mode: 0o600 });
  let engine: string;
  const os = platform();
  if (os === 'darwin') {
    engine = 'macOS say Samantha rate 150';
    const aiff = join(directory, 'speech.aiff');
    await exec('/usr/bin/say', ['-v', 'Samantha', '-r', '150', '-f', speechText, '-o', aiff], { timeout: 60_000, maxBuffer: 64 * 1024 });
    await exec('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', aiff, wavPath], { timeout: 30_000, maxBuffer: 64 * 1024 });
  } else if (os === 'win32') {
    engine = 'Windows System.Speech default installed voice';
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
try { $s.SetOutputToWaveFile($env:HQ_MEET_FIXTURE_WAV); $s.Speak([IO.File]::ReadAllText($env:HQ_MEET_FIXTURE_TEXT));
$s.Voice.Name } finally { $s.Dispose() }`;
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      timeout: 60_000, maxBuffer: 64 * 1024, windowsHide: true,
      env: { ...process.env, HQ_MEET_FIXTURE_WAV: wavPath, HQ_MEET_FIXTURE_TEXT: speechText },
    });
    engine += ` (${result.stdout.trim()})`;
  } else throw new Error('fixture speech generation requires macOS or Windows');
  const speech = await readFile(wavPath);
  if (speech.length < 44 || speech.length > 12_000_000 || speech.toString('ascii', 0, 4) !== 'RIFF' || speech.toString('ascii', 8, 12) !== 'WAVE') throw new Error('native engine did not produce bounded WAV audio');
  const filePath = join(directory, 'public-file.bin');
  const file = await open(filePath, 'wx', 0o600);
  try { for (const chunk of fileFixture(fileSizeBytes)) await file.writeFile(chunk); }
  finally { await file.close(); }
  const manifest = { ...fixtureManifest, engine, os, osKernelVersion: release(), speechWavPath: wavPath,
    speechWavSha256: sha256(speech), filePath, fileSizeBytes, fileSha256: fileFixtureHash(fileSizeBytes) };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return manifest;
}
