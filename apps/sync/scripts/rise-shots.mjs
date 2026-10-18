// Headless stills and clips of the rise treatment from the dev harness
// (?view=rise). Run with the harness up: npm run dev:preview, then
// node scripts/rise-shots.mjs <framesDir> <clipsDir>
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const framesDir = process.argv[2] ?? '/tmp/rise-frames';
const clipsDir = process.argv[3] ?? '/tmp/rise-clips';
mkdirSync(framesDir, { recursive: true });
mkdirSync(clipsDir, { recursive: true });

const base = 'http://localhost:1422/?view=rise';
const STILLS = [
  { phase: 'opening', t: '1', name: 'opening' },
  { phase: 'reveal', t: '9.35', name: 'reveal' },
  { phase: 'brief', t: null, name: 'brief' },
];

const browser = await chromium.launch();
const errors = [];

for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    colorScheme: theme,
  });
  page.on('pageerror', (error) => errors.push(`${theme} ${error.message}`));
  for (const still of STILLS) {
    const t = still.t == null ? '' : `&t=${still.t}`;
    await page.goto(`${base}&phase=${still.phase}&theme=${theme}${t}`, { waitUntil: 'load', timeout: 120000 });
    const selector = still.phase === 'brief' ? '[data-testid="welcome-report-ready"]' : '[data-testid="brief-rise"]';
    await page.waitForSelector(selector, { timeout: 120000 });
    await page.waitForTimeout(700);
    const file = join(framesDir, `app-1670-rise-${theme}-${still.name}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
  await page.close();
}

for (const theme of ['dark', 'light']) {
  const dir = join(clipsDir, `raw-${theme}`);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: theme,
    recordVideo: { dir, size: { width: 1280, height: 900 } },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`clip ${theme} ${error.message}`));
  await page.goto(`${base}&phase=record&theme=${theme}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('[data-testid="brief-rise"]', { timeout: 120000 });
  await page.waitForTimeout(25000);
  await page.close();
  await context.close();
  const webm = readdirSync(dir).find((name) => name.endsWith('.webm'));
  if (!webm) {
    errors.push(`clip ${theme} produced no webm`);
    continue;
  }
  const dest = join(clipsDir, `app-1670-rise-${theme}.webm`);
  renameSync(join(dir, webm), dest);
  console.log(dest);
}

await browser.close();
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
}
