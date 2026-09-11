import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkResult(status: number | null, error?: string) {
  return status === 0 && !error ? 'passed' : 'failed';
}

export function createRun(startedAt: string) {
  return {
    startedAt,
    mode: 'local-regression-not-live-e2e',
    cleanupBudgetMs: 120_000,
    resources: [] as Array<{ uid: string; name: string; owner: string; createdByThisRun: boolean; cleanup: string }>,
    nativeChecks: [
      'Website-created company is offered to the same signed-in user; no duplicate company',
      'Company name generates an editable slug; editing is preserved',
      'No internal IDs appear in cards or progression controls',
      'Create shows immediate pending state and prevents duplicate submission',
      'Creation opens the team channel and leaves a durable Open channel link',
      'Cloud pending, success and retry states are clear',
      'Stay on Starter completes setup without a blocked agent form',
      'Paid agent option shows the actual quote before any commitment',
      'Authorized agent provisioning reaches ready and the agent replies',
      'Navigate away and restart: company, membership and progression persist',
      'Non-owner cannot perform owner-only onboarding actions',
    ].map(check => ({ check, status: 'pending', evidence: '' })),
  };
}

/** Fixed, local-only suites. No deploy, billing, cloud creation or teardown. */
const suites = [
  { name: 'cards', cwd: 'packages/ui', args: ['src/chat/messaging/LifecycleCard.test.ts', 'src/chat/messaging/ChannelConversation.lifecycle.test.ts'] },
  { name: 'lifecycle-simulator', cwd: 'apps/sync', args: ['__tests__/stories/lifecycle-browser-scenario.test.ts', '__tests__/stories/lifecycle-cards.test.ts'] },
];

async function runSuite(root: string, output: string, suite: typeof suites[number]) {
  const started = Date.now();
  // Detached process group lets the timeout stop this suite and its workers,
  // without touching any app or other user's test process.
  const child = spawn('pnpm', ['exec', 'vitest', 'run', ...suite.args], {
    cwd: resolve(root, suite.cwd), detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let error = '';
  const capture = (data: Buffer) => { log = (log + data.toString()).slice(-2_000_000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const kill = () => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch { /* Already exited. */ }
  };
  const timeout = setTimeout(() => { error = 'Timed out after 60 seconds'; kill(); }, 60_000);
  const status = await new Promise<number | null>(done => {
    child.on('error', e => { error = e.message; done(null); });
    child.on('close', done);
  });
  clearTimeout(timeout);
  await writeFile(resolve(output, `${suite.name}.log`), log + (error ? `\n${error}\n` : ''));
  return { name: suite.name, status: checkResult(status, error), elapsedMs: Date.now() - started, error };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const run = createRun(new Date().toISOString());
  const output = resolve(root, 'output/onboarding', run.startedAt.replace(/[:.]/g, '-'));
  await mkdir(output, { recursive: true });
  // Persist the checklist before running anything, so interrupted runs resume.
  await writeFile(resolve(output, 'native-checks.json'), JSON.stringify(run, null, 2) + '\n');
  const results = await Promise.all(suites.map(suite => runSuite(root, output, suite)));
  await writeFile(resolve(output, 'regressions.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(results.map(result => `${result.name}: ${result.status} (${result.elapsedMs}ms)`).join('\n'));
  console.log(`Evidence: ${output}\nNative E2E remains pending: record observed results in native-checks.json.`);
  if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
