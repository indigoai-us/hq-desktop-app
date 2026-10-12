// Screenshots of the first-run "Your apps" step from the design harness
// (?view=your-apps). Run with the harness up: npm run dev:preview, then
// node scripts/your-apps-shots.mjs <outDir>. Preview only; no app build.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? '/tmp/your-apps-shots';
mkdirSync(out, { recursive: true });
const base = 'http://localhost:1422/?view=your-apps&state=';

const STATES = [
  { state: 'auto' },
  { state: 'connect' },
  { state: 'connecting', press: 'first-run-connect-linear.app' },
  { state: 'failed', press: 'first-run-connect-linear.app' },
  { state: 'docs', press: 'first-run-connect-zoom.us' },
  { state: 'member' },
  { state: 'empty' },
  { state: 'many' },
];
const SIZES = [
  { w: 1200, h: 800 },
  { w: 960, h: 600 },
];

const browser = await chromium.launch();
const errors = [];
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size.w, height: size.h }, colorScheme: 'dark' });
  page.on('pageerror', (e) => errors.push(`${size.w} ${e.message}`));
  for (const s of STATES) {
    await page.goto(base + s.state, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="first-run-apps-lead"]', { timeout: 15000 });
    await page.waitForTimeout(900);
    if (s.press) {
      await page.click(`[data-testid="${s.press}"]`);
      await page.waitForTimeout(700);
    }
    const file = `${out}/your-apps-${s.state}-${size.w}x${size.h}.png`;
    await page.screenshot({ path: file });
    console.log(file);
    // The long states also get a capture scrolled to the bottom of the step body.
    if (s.state === 'auto' || s.state === 'many' || s.state === 'member') {
      await page.evaluate(() => {
        const body = document.querySelector('[data-testid="first-run-apps"]');
        if (body) body.scrollTop = body.scrollHeight;
      });
      await page.waitForTimeout(300);
      const scrolled = `${out}/your-apps-${s.state}-scrolled-${size.w}x${size.h}.png`;
      await page.screenshot({ path: scrolled });
      console.log(scrolled);
    }
  }
  await page.close();
}
await browser.close();
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
}
