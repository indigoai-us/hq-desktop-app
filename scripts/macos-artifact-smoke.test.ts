import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  DEEP_LINK,
  DEFAULT_TIMEOUT_MS,
  SMOKE_TOKEN_SECRET,
  evaluateSmokeResult,
  isSmokeTempDir,
  parseBootLog,
  readBundleVersion,
  removeSmokeHome,
  requireNonIndigoRefreshToken,
  runArtifactSmoke,
  runCli,
  smokeError,
  tagLatestJsonUrl,
  verifyPublishedLatestJson,
  writeSmokeHome,
} from "./macos-artifact-smoke.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function plist(version: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>
`;
}

async function fakeApp(version: string) {
  const root = await mkdtemp(join(tmpdir(), "hq-smoke-app-"));
  const app = join(root, "HQ.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), plist(version));
  await writeFile(join(app, "Contents", "MacOS", "hq-sync-menubar"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  return app;
}

describe("non-Indigo refresh token is fail-closed", () => {
  it("rejects a missing, empty, or whitespace secret", () => {
    expect(() => requireNonIndigoRefreshToken({})).toThrow(/HQ_RELEASE_SMOKE_REFRESH_TOKEN_NON_INDIGO is missing/);
    expect(() => requireNonIndigoRefreshToken({ [SMOKE_TOKEN_SECRET]: "" })).toThrow(
      /missing or empty/,
    );
    expect(() => requireNonIndigoRefreshToken({ [SMOKE_TOKEN_SECRET]: "   " })).toThrow(
      /missing or empty/,
    );
    expect(requireNonIndigoRefreshToken({ [SMOKE_TOKEN_SECRET]: " rt-non-indigo " })).toBe(
      "rt-non-indigo",
    );
  });

  it("names the production hole in the error so a skipped secret cannot look optional", () => {
    expect(smokeError("x").message).toMatch(/^macos-artifact-smoke: x$/);
    expect(() => requireNonIndigoRefreshToken({})).toThrow(/v0\.10\.178/);
    expect(() => requireNonIndigoRefreshToken({})).toThrow(/fail-closed/);
  });
});

describe("bundle version and boot log", () => {
  it("reads CFBundleShortVersionString from Info.plist", async () => {
    const app = await fakeApp("0.10.179");
    expect(readBundleVersion(app)).toBe("0.10.179");
  });

  it("treats shell_ready as the first-paint signal and recovery as a failure", () => {
    expect(parseBootLog("boot: desktop-alt window created\nboot: shell_ready from UI")).toEqual({
      shellReady: true,
      windowCreated: true,
      recoveryOpened: false,
      watchdogTimeout: false,
    });
    expect(
      parseBootLog("watchdog timeout — desktop shell did not report ready"),
    ).toMatchObject({ watchdogTimeout: true, shellReady: false });
  });

  it("passes only when version matches and shell_ready fired without recovery", () => {
    expect(
      evaluateSmokeResult({
        log: parseBootLog("shell_ready from UI"),
        bundleVersion: "0.10.179",
        expectedVersion: "v0.10.179",
        timedOut: false,
      }),
    ).toEqual({ ok: true, version: "0.10.179" });

    expect(() =>
      evaluateSmokeResult({
        log: parseBootLog("shell_ready from UI"),
        bundleVersion: "0.10.178",
        expectedVersion: "0.10.179",
        timedOut: false,
      }),
    ).toThrow(/does not match tag/);

    expect(() =>
      evaluateSmokeResult({
        log: parseBootLog("recovery window opened (trigger=watchdog-timeout, version=v0.10.179)"),
        bundleVersion: "0.10.179",
        expectedVersion: "0.10.179",
        timedOut: false,
      }),
    ).toThrow(/recovery window opened/);

    expect(() =>
      evaluateSmokeResult({
        log: parseBootLog(""),
        bundleVersion: "0.10.179",
        expectedVersion: "0.10.179",
        timedOut: true,
      }),
    ).toThrow(/shell_ready did not fire/);
  });
});

describe("smoke home", () => {
  it("writes an expired refresh-token file and a completed first-run menubar", async () => {
    const home = await mkdtemp(join(tmpdir(), "hq-smoke-home-"));
    const { logPath } = await writeSmokeHome({
      home,
      refreshToken: "rt-non-indigo",
    });
    const tokens = JSON.parse(
      await readFile(join(home, ".hq", "cognito-tokens.json"), "utf8"),
    );
    const menubar = JSON.parse(await readFile(join(home, ".hq", "menubar.json"), "utf8"));
    expect(tokens.refreshToken).toBe("rt-non-indigo");
    expect(tokens.expiresAt).toBe(1);
    expect(tokens.accessToken).not.toBe("");
    expect(menubar.firstRunCompleted).toBe(true);
    expect(menubar.startAtLogin).toBe(false);
    expect(menubar.widgetEnabled).toBe(false);
    expect(logPath).toBe(join(home, ".hq", "logs", "hq-sync.log"));
  });
});

describe("published latest.json for a tag", () => {
  it("builds the tag-pinned URL, never /releases/latest", () => {
    expect(tagLatestJsonUrl("indigoai-us/hq-desktop-app", "v0.10.179")).toBe(
      "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.179/latest.json",
    );
    expect(tagLatestJsonUrl("indigoai-us/hq-desktop-app", "v0.10.179")).not.toContain(
      "/releases/latest/",
    );
  });

  it("rejects a latest.json that would pull users onto the GitHub latest alias", () => {
    const good = {
      version: "0.10.179",
      platforms: {
        "darwin-aarch64": {
          url: "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.179/HQ_0.10.179_universal.app.tar.gz",
          signature: "sig",
        },
        "darwin-x86_64": {
          url: "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.179/HQ_0.10.179_universal.app.tar.gz",
          signature: "sig",
        },
        "windows-x86_64": {
          url: "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.179/HQ_0.10.179_x64-setup.exe",
          signature: "sig",
        },
        "windows-aarch64": {
          url: "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.179/HQ_0.10.179_arm64-setup.exe",
          signature: "sig",
        },
      },
    };
    expect(verifyPublishedLatestJson(good, "v0.10.179").darwinUrl).toContain(
      "/releases/download/v0.10.179/",
    );
    expect(() =>
      verifyPublishedLatestJson(
        {
          ...good,
          platforms: {
            ...good.platforms,
            "darwin-aarch64": {
              url: "https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/HQ_0.10.179_universal.app.tar.gz",
              signature: "sig",
            },
          },
        },
        "0.10.179",
      ),
    ).toThrow(/\/releases\/latest\/download\//);
    expect(() => verifyPublishedLatestJson({ ...good, version: "0.10.178" }, "0.10.179")).toThrow(
      /does not match/,
    );
  });
});

describe("launch smoke", () => {
  it("launches the binary with the setup deep link under an isolated HOME", async () => {
    const app = await fakeApp("0.10.179");
    const spawned: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: number;
      killed: boolean;
      kill: () => boolean;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    fakeChild.pid = 4242;
    fakeChild.killed = false;
    fakeChild.kill = () => {
      fakeChild.killed = true;
      return true;
    };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const result = await runArtifactSmoke({
      appPath: app,
      expectedVersion: "0.10.179",
      timeoutMs: 1_000,
      env: { [SMOKE_TOKEN_SECRET]: "rt-non-indigo" },
      launch: true,
      spawnImpl: ((cmd, args, options) => {
        spawned.push({ cmd: String(cmd), args: args as string[], env: options.env });
        return fakeChild;
      }) as typeof import("node:child_process").spawn,
      sleep: async () => {
        fakeChild.stderr.emit(
          "data",
          Buffer.from("[boot] desktop-alt window created\n[boot] shell_ready from UI\n"),
        );
      },
    });

    expect(result).toEqual({ ok: true, version: "0.10.179" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual([DEEP_LINK]);
    expect(spawned[0].env.HQ_DESKTOP_WATCHDOG_SECS).toBe("25");
    expect(spawned[0].env.HOME).toMatch(/hq-release-smoke-/);
    expect(spawned[0].env.TMPDIR).toBe(spawned[0].env.HOME);
    expect(spawned[0].env.NPM_CONFIG_CACHE).toBe(join(spawned[0].env.HOME, ".npm"));
    expect(spawned[0].cmd).toContain("hq-sync-menubar");
  });

  it("fails closed without launching when the secret is missing", async () => {
    const app = await fakeApp("0.10.179");
    await expect(
      runArtifactSmoke({
        appPath: app,
        expectedVersion: "0.10.179",
        env: {},
        launch: true,
      }),
    ).rejects.toThrow(/HQ_RELEASE_SMOKE_REFRESH_TOKEN_NON_INDIGO is missing/);
  });

  it("still reports smoke success when temp cleanup throws ENOTEMPTY", async () => {
    const app = await fakeApp("0.10.179");
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: number;
      killed: boolean;
      kill: () => boolean;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    fakeChild.pid = 7;
    fakeChild.killed = false;
    fakeChild.kill = () => {
      fakeChild.killed = true;
      return true;
    };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const warnings: string[] = [];
    const result = await runArtifactSmoke({
      appPath: app,
      expectedVersion: "0.10.179",
      timeoutMs: 1_000,
      env: { [SMOKE_TOKEN_SECRET]: "rt-non-indigo" },
      launch: true,
      spawnImpl: (() => fakeChild) as typeof import("node:child_process").spawn,
      sleep: async () => {
        fakeChild.stderr.emit("data", Buffer.from("[boot] shell_ready from UI\n"));
      },
      removeHomeImpl: () => {
        throw Object.assign(
          new Error(
            "ENOTEMPTY: directory not empty, rmdir '/tmp/hq-release-smoke-x/.npm/_cacache/index-v5'",
          ),
          { code: "ENOTEMPTY" },
        );
      },
      warn: (message) => warnings.push(String(message)),
    });

    expect(result).toEqual({ ok: true, version: "0.10.179" });
    expect(warnings.join("\n")).toMatch(/^::warning::/);
    expect(warnings.join("\n")).toMatch(/ENOTEMPTY/);
  });

  it("preserves a smoke failure when temp cleanup also throws", async () => {
    const app = await fakeApp("0.10.179");
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: number;
      killed: boolean;
      kill: () => boolean;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    fakeChild.pid = 8;
    fakeChild.killed = false;
    fakeChild.kill = () => {
      fakeChild.killed = true;
      return true;
    };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    let t = 0;
    await expect(
      runArtifactSmoke({
        appPath: app,
        expectedVersion: "0.10.179",
        timeoutMs: 5,
        env: { [SMOKE_TOKEN_SECRET]: "rt-non-indigo" },
        launch: true,
        spawnImpl: (() => fakeChild) as typeof import("node:child_process").spawn,
        now: () => t,
        sleep: async () => {
          t += 10;
        },
        removeHomeImpl: () => {
          throw Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir 'x'"), {
            code: "ENOTEMPTY",
          });
        },
        warn: () => {},
      }),
    ).rejects.toThrow(/shell_ready did not fire/);
  });
});

describe("smoke temp cleanup", () => {
  it("treats mkdtemp hq-release-smoke dirs as removable and refuses /", () => {
    expect(isSmokeTempDir(join(tmpdir(), "hq-release-smoke-fqTFZB"))).toBe(true);
    expect(isSmokeTempDir("/")).toBe(false);
    expect(isSmokeTempDir("/var/folders/tmp")).toBe(false);
    expect(isSmokeTempDir("")).toBe(false);
  });

  it("recursively force-removes a temp dir npm populated with a cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hq-release-smoke-"));
    await mkdir(join(dir, ".npm", "_cacache", "index-v5"), { recursive: true });
    await mkdir(join(dir, ".npm", "_cacache", "content-v2", "ab"), { recursive: true });
    await writeFile(join(dir, ".npm", "_cacache", "index-v5", "entry"), "cached");
    await writeFile(join(dir, ".npm", "_cacache", "content-v2", "ab", "cd"), "blob");
    expect(removeSmokeHome(dir)).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(false);
  });

  it("uses rmSync recursive+force, then rm -rf, and warns instead of throwing on ENOTEMPTY", () => {
    const dir = join(tmpdir(), "hq-release-smoke-fqTFZB");
    const warnings: string[] = [];
    const rmCalls: Array<{ path: string; opts: object }> = [];
    const error = Object.assign(
      new Error(`ENOTEMPTY: directory not empty, rmdir '${dir}/.npm/_cacache/index-v5'`),
      { code: "ENOTEMPTY" },
    );

    const result = removeSmokeHome(dir, {
      rmSyncImpl: ((path, opts) => {
        rmCalls.push({ path: String(path), opts: opts as object });
        throw error;
      }) as typeof import("node:fs").rmSync,
      spawnSyncImpl: (() => ({
        status: 1,
        stderr: "rm: Directory not empty",
        error: undefined,
      })) as typeof import("node:child_process").spawnSync,
      warn: (message) => warnings.push(String(message)),
    });

    expect(rmCalls).toEqual([{ path: dir, opts: { recursive: true, force: true } }]);
    expect(result.ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^::warning::macos-artifact-smoke: failed to remove temp dir /);
    expect(warnings[0]).toMatch(/ENOTEMPTY/);
  });

  it("falls back to rm -rf when rmSync hits ENOTEMPTY", () => {
    const dir = join(tmpdir(), "hq-release-smoke-fallback");
    const rmArgs: string[][] = [];
    const result = removeSmokeHome(dir, {
      rmSyncImpl: () => {
        throw Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir 'index-v5'"), {
          code: "ENOTEMPTY",
        });
      },
      spawnSyncImpl: ((cmd, args) => {
        rmArgs.push([String(cmd), ...(args as string[])]);
        return { status: 0, stderr: "", error: undefined };
      }) as typeof import("node:child_process").spawnSync,
      warn: () => {
        throw new Error("must not warn when rm -rf succeeds");
      },
    });
    expect(result).toEqual({ ok: true, usedFallback: true });
    expect(rmArgs).toEqual([["/bin/rm", "-rf", "--", dir]]);
  });
});

describe("CLI", () => {
  it("checks the bundle version without launching", async () => {
    const app = await fakeApp("0.10.179");
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const result = await runCli(["--app", app, "--version", "0.10.179"], {
        env: { [SMOKE_TOKEN_SECRET]: "rt-non-indigo" },
      });
      expect(result).toMatchObject({ ok: true, version: "0.10.179", launched: false });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(chunks.join("")).toContain('"launched":false');
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it("verifies a published latest.json without launching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hq-smoke-json-"));
    const path = join(dir, "latest.json");
    await writeFile(
      path,
      JSON.stringify({
        version: "0.10.179",
        platforms: {
          "darwin-aarch64": {
            url: "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.179/HQ_0.10.179_universal.app.tar.gz",
            signature: "sig",
          },
          "darwin-x86_64": {
            url: "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.179/HQ_0.10.179_universal.app.tar.gz",
            signature: "sig",
          },
          "windows-x86_64": {
            url: "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.179/HQ_0.10.179_x64-setup.exe",
            signature: "sig",
          },
          "windows-aarch64": {
            url: "https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.179/HQ_0.10.179_arm64-setup.exe",
            signature: "sig",
          },
        },
      }),
    );
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["--latest-json", path, "--version", "0.10.179"]);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(chunks.join("")).toContain("HQ_0.10.179_universal.app.tar.gz");
    expect(resolve(here, "macos-artifact-smoke.mjs")).toContain("macos-artifact-smoke.mjs");
  });
});
