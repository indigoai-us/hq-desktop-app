/**
 * Headless light and dark shots of the company jobs preview.
 * Writes PNGs to the folder named by COMPANY_JOBS_SHOTS, which is required.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const uiDir = fileURLToPath(new URL("..", import.meta.url));
const { chromium } = createRequire(new URL("../../../apps/sync/package.json", import.meta.url))("@playwright/test");

const outDir = process.env.COMPANY_JOBS_SHOTS;
if (!outDir) {
  console.error("Set COMPANY_JOBS_SHOTS to the folder the screenshots should go in.");
  process.exit(1);
}
const shots = [
  "list",
  "empty-admin",
  "empty-member",
  "add",
  "watchdog",
  "invalid",
  "waiting",
  "log",
  "paused",
  "member",
  "load-error",
  "blocked",
  "not-available",
  "not-available-member",
];
const themes = ["light", "dark"];

const viteBin = fileURLToPath(new URL("../../../apps/sync/node_modules/.bin/vite", import.meta.url));
const vite = spawn(
  viteBin,
  ["--config", `${uiDir}/vite.company-jobs-preview.config.ts`],
  { cwd: uiDir, stdio: ["ignore", "pipe", "pipe"] },
);

let ready = "";
let log = "";
function take(chunk) {
  const text = String(chunk);
  log += text;
  const match = text.match(/http:\/\/127\.0\.0\.1:\d+\//);
  if (match) ready = match[0];
}
vite.stdout.on("data", take);
vite.stderr.on("data", take);

const deadline = Date.now() + 20000;
while (!ready && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) {
  vite.kill("SIGTERM");
  throw new Error(`preview server did not start\n${log}`);
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") pageErrors.push(msg.text());
});
const written = [];
try {
  for (const theme of themes) {
    for (const shot of shots) {
      pageErrors.length = 0;
      const url = `${ready}company-jobs-preview.html?shot=${shot}&theme=${theme}`;
      await page.goto(url, { waitUntil: "networkidle" });
      try {
        await page.waitForSelector("html[data-shot-ready='true']", { timeout: 8000 });
      } catch (err) {
        const body = await page.locator("body").innerText().catch(() => "");
        throw new Error(`${shot} ${theme} did not settle\n${pageErrors.join("\n")}\n${body.slice(0, 500)}\n${err}`);
      }
      const file = `${outDir}/company-jobs-${shot}-${theme}.png`;
      await page.screenshot({ path: file });
      written.push(file);
    }
  }
} finally {
  await browser.close();
  vite.kill("SIGTERM");
}
console.log(written.join("\n"));
