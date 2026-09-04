#!/usr/bin/env node

/**
 * Post-build (and optional post-publish) smoke for the macOS HQ.app.
 *
 * Launches the signed bundle under an isolated HOME with a NON-INDIGO Cognito
 * refresh token, waits for `shell_ready from UI` in the boot log, and asserts
 * the bundle version matches the tag. Missing credentials fail closed — there
 * is no skip path. That is the hole that shipped v0.10.178: every check ran
 * as an Indigo user with conversations.
 *
 *   node scripts/macos-artifact-smoke.mjs --app path/to/HQ.app --version 0.10.179 --launch
 *   node scripts/macos-artifact-smoke.mjs --latest-json path/or/url --version 0.10.179
 *
 * Secret: HQ_RELEASE_SMOKE_REFRESH_TOKEN_NON_INDIGO
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const SMOKE_TOKEN_SECRET = "HQ_RELEASE_SMOKE_REFRESH_TOKEN_NON_INDIGO";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEEP_LINK = "hqwork://open?channel=setup";
export const SMOKE_TEMP_PREFIX = "hq-release-smoke-";
export const CHILD_STOP_WAIT_MS = 1_000;
export const LATEST_JSON_FETCH_TIMEOUT_MS = 30_000;

export function smokeError(message) {
  return new Error(`macos-artifact-smoke: ${message}`);
}

function defaultWarn(message) {
  console.warn(message);
}

export function isSmokeTempDir(dir) {
  if (typeof dir !== "string" || !dir.trim()) return false;
  const resolved = resolve(dir);
  if (resolved === "/" || /^[A-Za-z]:\\?$/.test(resolved)) return false;
  return resolved.split(/[\\/]/).some((part) => part.startsWith(SMOKE_TEMP_PREFIX));
}

/**
 * Recursively delete the isolated smoke HOME. npm (and the Recall sidecar)
 * populate `$HOME/.npm/_cacache` while the app runs; a non-recursive rmdir
 * or an uncaught `fs.rm` ENOTEMPTY then fails the GitHub step and can mask
 * the real smoke result. Never throws — cleanup failure is a warning.
 */
export function removeSmokeHome(dir, options = {}) {
  const {
    rmSyncImpl = rmSync,
    spawnSyncImpl = spawnSync,
    warn = defaultWarn,
  } = options;

  if (!isSmokeTempDir(dir)) {
    if (dir) {
      warn(
        `::warning::macos-artifact-smoke: refused to remove unexpected path ${String(dir)}`,
      );
    }
    return { ok: true, skipped: true };
  }

  try {
    rmSyncImpl(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    const fallback = spawnSyncImpl("/bin/rm", ["-rf", "--", dir], {
      encoding: "utf8",
    });
    if (!fallback?.error && fallback?.status === 0) {
      return { ok: true, usedFallback: true };
    }
    const detail =
      error?.message ||
      fallback?.stderr ||
      fallback?.error?.message ||
      "directory still exists";
    warn(`::warning::macos-artifact-smoke: failed to remove temp dir ${dir}: ${detail}`);
    return { ok: false, error };
  }
}

export function requireNonIndigoRefreshToken(env = process.env) {
  const token = typeof env[SMOKE_TOKEN_SECRET] === "string" ? env[SMOKE_TOKEN_SECRET].trim() : "";
  if (!token) {
    throw smokeError(
      `${SMOKE_TOKEN_SECRET} is missing or empty. Provision a Cognito refresh token for a non-Indigo account whose inbox is empty (only #setup) and store it as that repository secret. This gate is fail-closed so a missing identity cannot skip the check that would have caught v0.10.178.`,
    );
  }
  return token;
}

export function normalizeVersion(input) {
  const raw = String(input ?? "").trim();
  const stripped = raw.replace(/^v/i, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|alpha)\.(0|[1-9]\d*))?$/.test(stripped)) {
    throw smokeError(`expected X.Y.Z or X.Y.Z-beta.N, got ${JSON.stringify(input)}`);
  }
  return stripped;
}

export function readBundleVersion(appPath) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) {
    throw smokeError(`Info.plist is missing at ${plistPath}`);
  }
  const xml = readFileSync(plistPath, "utf8");
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  if (!match) {
    throw smokeError(`CFBundleShortVersionString is missing from ${plistPath}`);
  }
  return normalizeVersion(match[1]);
}

export function parseBootLog(text) {
  const source = String(text ?? "");
  return {
    shellReady: /shell_ready from UI/.test(source),
    windowCreated: /desktop-alt window created/.test(source),
    recoveryOpened: /recovery window opened/.test(source),
    watchdogTimeout: /watchdog timeout/.test(source),
  };
}

export function evaluateSmokeResult({
  log,
  bundleVersion,
  expectedVersion,
  timedOut,
}) {
  const expected = normalizeVersion(expectedVersion);
  const actual = normalizeVersion(bundleVersion);
  if (actual !== expected) {
    throw smokeError(
      `bundle version ${actual} does not match tag ${expected}`,
    );
  }
  if (log.recoveryOpened) {
    throw smokeError(
      "recovery window opened before the shell painted — conversation area never left the skeleton",
    );
  }
  if (log.watchdogTimeout) {
    throw smokeError(
      "boot watchdog timed out — conversation area never left the skeleton",
    );
  }
  if (timedOut || !log.shellReady) {
    throw smokeError(
      `shell_ready did not fire within the deadline; conversation area still looks like a skeleton (windowCreated=${Boolean(log.windowCreated)})`,
    );
  }
  return { ok: true, version: actual };
}

export function tagLatestJsonUrl(repository, tag) {
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw smokeError(`invalid repository ${String(repository)}`);
  }
  const name = String(tag ?? "").trim();
  if (!name.startsWith("v")) {
    throw smokeError(`expected a v-prefixed tag, got ${JSON.stringify(tag)}`);
  }
  return `https://github.com/${repository}/releases/download/${name}/latest.json`;
}

export function verifyPublishedLatestJson(manifest, expectedVersion) {
  const version = normalizeVersion(expectedVersion);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw smokeError("latest.json must be an object");
  }
  if (normalizeVersion(manifest.version) !== version) {
    throw smokeError(
      `latest.json version ${String(manifest.version)} does not match ${version}`,
    );
  }
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object") {
    throw smokeError("latest.json is missing platforms");
  }
  const required = [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
    "windows-aarch64",
  ];
  const missing = required.filter((name) => !platforms[name]);
  if (missing.length) {
    throw smokeError(`latest.json is missing platforms ${missing.join(", ")}`);
  }
  for (const [name, entry] of Object.entries(platforms)) {
    if (!entry || typeof entry.url !== "string" || !entry.url.trim()) {
      throw smokeError(`latest.json ${name} is missing url`);
    }
    if (entry.url.includes("/releases/latest/download/")) {
      throw smokeError(
        `latest.json ${name} URL uses /releases/latest/download/ instead of a tag-pinned asset`,
      );
    }
    if (typeof entry.signature !== "string" || !entry.signature.trim()) {
      throw smokeError(`latest.json ${name} has an empty signature`);
    }
  }
  return {
    version,
    darwinUrl: platforms["darwin-aarch64"].url,
    platforms: required,
  };
}

export async function writeSmokeHome({ home, refreshToken }) {
  const hqDir = join(home, ".hq");
  const logsDir = join(hqDir, "logs");
  await mkdir(logsDir, { recursive: true });
  const tokens = {
    accessToken: "expired-smoke-access-token",
    idToken: null,
    refreshToken,
    expiresAt: 1,
  };
  await writeFile(
    join(hqDir, "cognito-tokens.json"),
    `${JSON.stringify(tokens, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(hqDir, "menubar.json"),
    `${JSON.stringify(
      {
        firstRunCompleted: true,
        autoSyncNoticeShown: true,
        machineId: "release-smoke",
        startAtLogin: false,
        widgetEnabled: false,
        autoUpdate: false,
        realtimeSync: false,
        dockIcon: true,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const logPath = join(logsDir, "hq-sync.log");
  await writeFile(logPath, "", { mode: 0o600 });
  return { hqDir, logPath };
}

function bundleExecutableName(appPath) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) return "hq-sync-menubar";
  const xml = readFileSync(plistPath, "utf8");
  const match = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  const name = match?.[1]?.trim();
  return name || "hq-sync-menubar";
}

function resolveBinary(appPath) {
  const binary = join(appPath, "Contents", "MacOS", bundleExecutableName(appPath));
  if (!existsSync(binary)) {
    throw smokeError(`app binary is missing at ${binary}`);
  }
  return binary;
}

export async function launchAndWait({
  appPath,
  home,
  logPath,
  timeoutMs,
  spawnImpl = spawn,
  readLog = (path) => readFile(path, "utf8").catch(() => ""),
  now = () => Date.now(),
  sleep = delay,
  killGroup,
  warn = defaultWarn,
}) {
  const binary = resolveBinary(appPath);
  const child = spawnImpl(binary, [DEEP_LINK], {
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      NPM_CONFIG_CACHE: join(home, ".npm"),
      HQ_DESKTOP_WATCHDOG_SECS: "25",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  let spawnError;
  child.stdout?.on?.("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on?.("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on?.("error", (error) => {
    spawnError = error;
  });

  const deadline = now() + timeoutMs;
  let timedOut = true;
  let log = parseBootLog("");
  try {
    while (now() < deadline) {
      if (spawnError) {
        throw smokeError(`failed to launch app: ${spawnError.message}`);
      }
      const fileLog = await readLog(logPath);
      log = parseBootLog(`${fileLog}\n${stdout}\n${stderr}`);
      if (log.shellReady || log.recoveryOpened || log.watchdogTimeout) {
        timedOut = false;
        break;
      }
      await sleep(200);
    }
    if (spawnError) {
      throw smokeError(`failed to launch app: ${spawnError.message}`);
    }
    if (timedOut) {
      const fileLog = await readLog(logPath);
      log = parseBootLog(`${fileLog}\n${stdout}\n${stderr}`);
    }
    return { log, timedOut, stdout, stderr };
  } finally {
    const stopped = await stopChild(
      child,
      killGroup ? { sleep, killGroup } : { sleep },
    );
    // Teardown is advisory (a temp sandbox is not a product signal), so an
    // unreaped tree must not degrade to silence: say so out loud.
    if (!stopped.exited) {
      warn(
        `::warning::macos-artifact-smoke: smoke app (pid ${
          child?.pid ?? "unknown"
        }) did not confirm exit after SIGKILL; its process tree may not be fully reaped and may still be writing into the sandbox HOME`,
      );
    }
  }
}

/**
 * Reap the smoke app AND every descendant it spawned. The app is started
 * `detached: true`, so it leads its own process group; signalling only the
 * direct child leaves orphans (the sync runner via npx) writing into the
 * sandbox HOME while teardown walks it — which is how releases started dying
 * with `ENOTEMPTY ... .npm/_cacache/index-v5`.
 */
export async function stopChild(
  child,
  {
    sleep = delay,
    waitMs = CHILD_STOP_WAIT_MS,
    killGroup = (pid, signal) => process.kill(-pid, signal),
  } = {},
) {
  if (!child) return { exited: true, escalated: false };

  let exited = false;
  let settle = () => {};
  const exitedPromise = new Promise((resolveWait) => {
    settle = resolveWait;
  });
  const finish = () => {
    exited = true;
    settle();
  };
  // Subscribe BEFORE checking the exit state, then re-check. Checking first
  // leaves a TOCTOU gap: an exit that lands between the check and the
  // subscribe has already fired, so the listener never runs and `exited`
  // stays false through both grace waits.
  if (typeof child.once === "function") {
    child.once("exit", finish);
    child.once("close", finish);
  } else {
    finish();
  }
  if (child.exitCode != null || child.signalCode != null) finish();

  const send = (signal) => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
    const pid = child.pid;
    if (pid) {
      try {
        killGroup(pid, signal);
      } catch {
        /* no process group, or an empty one (ESRCH) — both are fine */
      }
    }
  };

  try {
    send("SIGTERM");
    await Promise.race([exitedPromise, sleep(waitMs)]);
    const exitedOnTerm = exited;
    // The leader exiting is NOT proof the tree is reaped: this only observes
    // the direct ChildProcess handle. Descendants that ignore SIGTERM, or that
    // outlive the leader while flushing cacache, keep writing into the sandbox
    // HOME. Always best-effort SIGKILL the group after the SIGTERM grace.
    send("SIGKILL");
    if (exitedOnTerm) return { exited: true, escalated: false };
    await Promise.race([exitedPromise, sleep(waitMs)]);
    return { exited, escalated: true };
  } finally {
    child.off?.("exit", finish);
    child.off?.("close", finish);
  }
}

export async function runArtifactSmoke({
  appPath,
  expectedVersion,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  launch = false,
  spawnImpl,
  readLog,
  now,
  sleep,
  mkdtempImpl = mkdtemp,
  removeHomeImpl = removeSmokeHome,
  warn = defaultWarn,
}) {
  const refreshToken = requireNonIndigoRefreshToken(env);
  const version = normalizeVersion(expectedVersion);
  if (!appPath) {
    throw smokeError("--app is required when launching or checking a bundle");
  }
  const resolvedApp = resolve(appPath);
  if (!existsSync(resolvedApp)) {
    throw smokeError(`HQ.app is missing at ${resolvedApp}`);
  }
  const bundleVersion = readBundleVersion(resolvedApp);
  if (!launch) {
    if (bundleVersion !== version) {
      throw smokeError(
        `bundle version ${bundleVersion} does not match tag ${version}`,
      );
    }
    return { ok: true, version: bundleVersion, launched: false };
  }

  const home = await mkdtempImpl(join(tmpdir(), SMOKE_TEMP_PREFIX));
  try {
    const { logPath } = await writeSmokeHome({ home, refreshToken });
    const { log, timedOut } = await launchAndWait({
      appPath: resolvedApp,
      home,
      logPath,
      timeoutMs,
      spawnImpl,
      readLog,
      now,
      sleep,
      warn,
    });
    return evaluateSmokeResult({
      log,
      bundleVersion,
      expectedVersion: version,
      timedOut,
    });
  } finally {
    try {
      removeHomeImpl(home);
    } catch (error) {
      warn(
        `::warning::macos-artifact-smoke: failed to remove temp dir ${home}: ${
          error?.message ?? error
        }`,
      );
    }
  }
}

export async function loadLatestJson(
  source,
  fetchImpl = fetch,
  { attempts = 5, retryDelayMs = 2_000 } = {},
) {
  const raw = String(source ?? "").trim();
  if (!raw) {
    throw smokeError("--latest-json is required");
  }
  if (/^https?:\/\//i.test(raw)) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(raw, {
          signal: AbortSignal.timeout(LATEST_JSON_FETCH_TIMEOUT_MS),
          headers: { "user-agent": "hq-desktop-macos-artifact-smoke" },
        });
        if (!response.ok) {
          throw smokeError(`latest.json HTTP ${response.status} from ${raw}`);
        }
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await delay(retryDelayMs);
        }
      }
    }
    throw lastError;
  }
  try {
    return JSON.parse(await readFile(raw, "utf8"));
  } catch (error) {
    throw smokeError(`failed to read latest.json from ${raw}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const values = {};
  let launch = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--launch") {
      launch = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw smokeError(`unexpected argument ${token}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw smokeError(`${token} requires a value`);
    }
    values[token.slice(2)] = value;
    index += 1;
  }
  return { values, launch };
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const { values, launch } = parseArgs(argv);
  const timeoutMs = values["timeout-ms"]
    ? Number(values["timeout-ms"])
    : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw smokeError("--timeout-ms must be a positive number");
  }

  if (values["latest-json"]) {
    const manifest = await loadLatestJson(
      values["latest-json"],
      options.fetchImpl ?? fetch,
    );
    const expected = values.version;
    if (!expected) {
      throw smokeError("--version is required with --latest-json");
    }
    const verified = verifyPublishedLatestJson(manifest, expected);
    if (!launch) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, launched: false, ...verified })}\n`,
      );
      return verified;
    }
    if (!values.app) {
      throw smokeError("--app is required when --launch is set with --latest-json");
    }
  }

  if (!values.app || !values.version) {
    throw smokeError("--app and --version are required");
  }

  const result = await runArtifactSmoke({
    appPath: values.app,
    expectedVersion: values.version,
    timeoutMs,
    env: options.env ?? process.env,
    launch,
    spawnImpl: options.spawnImpl,
    readLog: options.readLog,
    now: options.now,
    sleep: options.sleep,
    mkdtempImpl: options.mkdtempImpl,
    removeHomeImpl: options.removeHomeImpl,
    warn: options.warn,
  });
  process.stdout.write(`${JSON.stringify({ ...result, launched: launch })}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
