// Screenshots of the Custom domain sheet from the design harness
// (?view=custom-domain-shot). Run with the harness up: npm run dev:preview, then
// node scripts/custom-domain-shots.mjs <outDir>. Preview only; no app build.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? '/tmp/custom-domain-shots';
mkdirSync(out, { recursive: true });
const base = 'http://localhost:1422/?view=custom-domain-shot&state=';

const STATES = [
  { name: 'add', state: 'empty', type: 'app.example.com' },
  { name: 'reserved', state: 'empty', type: 'mine.hq.work' },
  { name: 'card-required', state: 'empty', type: 'app.example.com', press: 'custom-domain-add' },
  { name: 'waiting-for-dns', state: 'pending' },
  { name: 'root-domain', state: 'apex' },
  { name: 'live', state: 'live' },
  { name: 'remove-confirm', state: 'pending', press: 'custom-domain-remove' },
  { name: 'member', state: 'member' },
  { name: 'read-failed', state: 'failed' },
];

const browser = await chromium.launch();
const errors = [];
for (const scheme of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 760, height: 720 }, colorScheme: scheme });
  page.on('pageerror', (e) => errors.push(`${scheme} ${e.message}`));
  for (const s of STATES) {
    await page.goto(base + s.state, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="custom-domain-form"]', { timeout: 15000 });
    await page.waitForTimeout(500);
    if (s.type) await page.fill('[data-testid="custom-domain-input"]', s.type);
    if (s.press) {
      await page.click(`[data-testid="${s.press}"]`);
      await page.waitForTimeout(500);
    }
    const file = `${out}/custom-domain-${s.name}-${scheme}.png`;
    await page.locator('.sheet').screenshot({ path: file });
    console.log(file);
  }
  await page.close();
}
await browser.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
