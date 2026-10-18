// Headless light and dark shots of the company sign-in card.
// Starts the design harness itself, writes PNGs, then stops. No app build.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const out = process.argv[2] ?? "/tmp/company-outpost-signin-shots";
const port = 14721;
mkdirSync(out, { recursive: true });

const states = [
  "not-signed-in",
  "preparing",
  "code-entry",
  "signed-in",
  "expired",
  "failed",
  "member-unsigned",
  "member-signed",
];

const server = spawn(
  "pnpm",
  ["exec", "vite", "--config", "vite.preview.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"], detached: true },
);

let log = "";
server.stdout.on("data", (chunk) => { log += chunk; });
server.stderr.on("data", (chunk) => { log += chunk; });

try {
  const deadline = Date.now() + 45000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/dev-harness/company-outpost-signin.html?state=signed-in`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      // still booting
    }
    await delay(200);
  }
  if (!up) {
    console.error(log.slice(-4000) || "preview server did not answer");
    process.exitCode = 1;
  }

  const browser = up ? await chromium.launch() : null;
  const errors = [];
  if (browser) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 960, height: 720 },
      colorScheme: theme,
    });
    page.on("pageerror", (error) => errors.push(`${theme} ${error.message}`));
    for (const state of states) {
      const url = `http://127.0.0.1:${port}/dev-harness/company-outpost-signin.html?state=${state}&theme=${theme}`;
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-testid='company-outpost-box-detail-signin-slot']");
      const file = `${out}/signin-${state}-${theme}.png`;
      await page.locator("[data-testid='company-outpost-signin-preview']").screenshot({ path: file });
      console.log(file);
    }
    await page.close();
  }
  if (browser) await browser.close();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
} finally {
  if (server.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
  }
  if (!log.includes("Local:") && process.exitCode) console.error(log.slice(-2000));
}
