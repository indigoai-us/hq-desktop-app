/**
 * Headless light and dark shots of every Company Outpost fixture screen.
 * Serves the dev harness, writes PNGs, then stops the server.
 *
 *   node scripts/company-outpost-screenshots.mjs <output-dir>
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "tmp/company-outpost-screenshots"));
const port = 14321;
const screens = [
  "admin-list",
  "member-list",
  "empty-admin",
  "empty-member",
  "cap",
  "add",
  "confirm",
  "preparing",
  "unavailable-owner",
  "unavailable-admin",
  "detail-running",
  "detail-blocked-admin",
  "detail-blocked-member",
  "detail-unavailable-admin",
  "detail-unavailable-member",
  "detail-needs-attention",
  "detail-preparing",
  "remove",
  "failure",
  "already-exists",
  "job-stub",
  "member-detail",
];

const require = createRequire(path.join(root, "apps/sync/package.json"));
const { chromium } = require("@playwright/test");

const syncDir = path.join(root, "apps/sync");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: syncDir, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      text += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolve(text);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${text.slice(-4000)}`));
    });
  });
}

// The dev server compiles the harness on every navigation and drops its
// websocket after a dozen pages. The browser suite already serves one built
// bundle through `vite preview` for the same reason.
await run("pnpm", ["exec", "vite", "build", "--config", "vite.preview.config.ts", "--logLevel", "warn"]);

const vite = spawn(
  "pnpm",
  ["exec", "vite", "preview", "--config", "vite.preview.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: syncDir, stdio: ["ignore", "pipe", "pipe"], detached: true },
);

let log = "";
let viteExit = null;
vite.stdout.on("data", (chunk) => {
  log += chunk.toString();
});
vite.stderr.on("data", (chunk) => {
  log += chunk.toString();
});
vite.on("exit", (code) => {
  viteExit = code;
});

function stop() {
  try {
    process.kill(-vite.pid, "SIGTERM");
  } catch {
    if (!vite.killed) vite.kill("SIGTERM");
  }
}

async function ready() {
  const url = `http://127.0.0.1:${port}/`;
  let last = "no response";
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 200) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`dev harness did not start (${last})\n${log.slice(-2000)}`);
}

try {
  await ready();
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const notes = [];
  page.on("console", (message) => notes.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => notes.push(`pageerror: ${error.message}`));
  const written = [];
  for (const theme of ["light", "dark"]) {
    for (const screen of screens) {
      const url = `http://127.0.0.1:${port}/?view=company-outpost&screen=${screen}&theme=${theme}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      try {
        await page.waitForSelector("[data-testid='company-outpost'][data-ready='true']", { timeout: 20000 });
      } catch (error) {
        const body = await page.locator("body").innerText().catch(() => "");
        throw new Error(
          `${screen} ${theme} did not render (preview exit ${viteExit})\n${notes.slice(-30).join("\n")}\nBODY:\n${body.slice(0, 1500)}\n${log.slice(-2000)}\n${error}`,
        );
      }
      const file = path.join(outDir, `${theme}-${screen}.png`);
      await page.screenshot({ path: file, fullPage: true });
      written.push(file);
    }
  }
  await browser.close();
  process.stdout.write(`${written.length}\n${written.join("\n")}\n`);
} finally {
  stop();
}
