#!/usr/bin/env node
/**
 * Repeatable baseline for the console rail lane.
 *
 * Reuses the production design harness (`scripts/perf/harness-build.mjs`) and
 * Playwright already installed for apps/sync. No extra dependencies.
 *
 * Measures, against a cold browser context:
 *   - first contentful paint of the main shell (webview stand-in for the
 *     main window; the native Tauri process is not launched)
 *   - time until the Messages surface is interactive (conversation rail or
 *     the new-message control is in the document)
 *   - production JS and CSS bytes of that shell build, which is packages/ui's
 *     DesktopApp plus the sync app that mounts it
 *
 * Writes reports/perf/baseline-<YYYY-MM-DD>.json and prints the same JSON.
 *
 *   node scripts/perf/console-rail-baseline.mjs
 *   node scripts/perf/console-rail-baseline.mjs --reps 3
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { INIT_SCRIPT } from "./collectors.mjs";
import { HARNESS_ENTRY, HARNESS_OUT_DIR, buildHarness } from "./harness-build.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const reps = Number(
  argv.includes("--reps") ? argv[argv.indexOf("--reps") + 1] : 3,
);

function loadChromium() {
  const require = createRequire(resolve(rootDir, "apps/sync/package.json"));
  return require("@playwright/test").chromium;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

function serve(dir) {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = decodeURIComponent(url.pathname);
      if (path === "/" || path === "") path = HARNESS_ENTRY;
      const file = join(dir, path);
      if (!file.startsWith(dir)) {
        res.writeHead(403).end();
        return;
      }
      createReadStream(file)
        .on("error", () => res.writeHead(404).end("not found"))
        .on("open", () => {
          res.writeHead(200, {
            "content-type": MIME[extname(file)] ?? "application/octet-stream",
            "cache-control": "no-store",
          });
        })
        .pipe(res);
    });
    server.listen(0, "127.0.0.1", () =>
      done({
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
      }),
    );
  });
}

async function bytesByExt(dir, ext) {
  let total = 0;
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (full.endsWith(ext)) total += (await stat(full)).size;
    }
  }
  await walk(dir);
  return total;
}

const MESSAGES_READY = [
  '[data-testid="chat-conversation-list"]',
  '[data-testid="chat-sidebar"]',
  '[data-testid="chat-new-message"]',
].join(", ");

async function measureOnce(browser, origin) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.addInitScript(`(${INIT_SCRIPT})()`);
  const url = `${origin}${HARNESS_ENTRY}?view=shell&persona=indigo&theme=dark`;
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForSelector(MESSAGES_READY, { timeout: 30_000, state: "attached" });
  const messagesInteractiveMs = await page.evaluate(() => performance.now());
  await page.waitForTimeout(400);
  const paint = await page.evaluate(() => window.__hqPerf.paint);
  await context.close();
  return {
    firstContentfulPaintMs: paint["first-contentful-paint"] ?? null,
    messagesInteractiveMs,
  };
}

function median(values) {
  const sorted = [...values].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : Math.round(sorted[mid]);
}

const date = new Date().toISOString().slice(0, 10);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: rootDir,
  encoding: "utf8",
}).trim();

process.stdout.write("building production shell harness…\n");
await buildHarness();

const jsBytes = await bytesByExt(HARNESS_OUT_DIR, ".js");
const cssBytes = await bytesByExt(HARNESS_OUT_DIR, ".css");

const chromium = loadChromium();
const browser = await chromium.launch({ headless: true });
const { server, origin } = await serve(HARNESS_OUT_DIR);
const samples = [];
try {
  for (let i = 0; i < reps; i += 1) {
    process.stdout.write(`sample ${i + 1}/${reps}…\n`);
    samples.push(await measureOnce(browser, origin));
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

const report = {
  date,
  commit,
  reps,
  surface:
    "apps/sync production design harness (?view=shell&persona=indigo), Playwright Chromium, cold context. Native Tauri window cold start is not included.",
  coldStartFirstPaintMs: median(samples.map((s) => s.firstContentfulPaintMs)),
  messagesInteractiveMs: median(samples.map((s) => s.messagesInteractiveMs)),
  uiBundle: {
    package: "@hq/ui mounted by apps/sync design harness (production vite build)",
    jsBytes,
    cssBytes,
    totalBytes: jsBytes + cssBytes,
  },
  samples,
};

const outDir = resolve(rootDir, "reports/perf");
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, `baseline-${date}.json`);
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${outPath}\n${JSON.stringify(report, null, 2)}\n`);
