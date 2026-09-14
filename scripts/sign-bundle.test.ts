import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
function fixture(options: { keychain?: "present" | "missing"; identity?: string; failSign?: boolean; adHoc?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hq-sign-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const app = join(root, "HQ Test.app");
  mkdirSync(bin);
  for (const dir of ["MacOS", "Resources"]) mkdirSync(join(app, "Contents", dir), { recursive: true });
  writeFileSync(join(app, "Contents/MacOS/hq-sync-menubar"), "fixture");
  writeFileSync(join(app, "Contents/Resources/hq-tray-helper"), "fixture");
  const log = join(root, "calls.jsonl");
  for (const tool of ["security", "codesign", "file"]) {
    writeFileSync(join(bin, tool), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ tool: '${tool}', args }) + String.fromCharCode(10));
if ('${tool}' === 'security') console.log(process.env.TEST_IDENTITY);
if ('${tool}' === 'file') console.log('Mach-O 64-bit executable');
if ('${tool}' === 'codesign' && args.includes('--force') && process.env.TEST_FAIL === '1') { console.error('fixture signing failure'); process.exit(1); }
`, { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_IDENTITY: options.identity ?? "Test Identity", TEST_FAIL: options.failSign ? "1" : "0" };
  for (const key of ["HQ_SIGN_KEYCHAIN", "HQ_SIGN_ENTITLEMENTS", "HARDENED_RUNTIME", "TIMESTAMP"]) delete env[key];
  const keychain = join(root, "isolated keychain.db");
  if (options.keychain) env.HQ_SIGN_KEYCHAIN = keychain;
  if (options.keychain === "present") writeFileSync(keychain, "fixture");
  // /bin/bash is macOS's shipped Bash 3.2, deliberately not PATH's newer Bash.
  const result = spawnSync("/bin/bash", [resolve("apps/sync/scripts/sign-bundle.sh"), app, options.adHoc ? "-" : "Test Identity"], { env, encoding: "utf8" });
  let calls: { tool: string; args: string[] }[] = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch {}
  return { ...result, calls, keychain };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("bundle signing under the system Bash", () => {
  it("signs and verifies using the default keychain scope when no override is set", () => {
    const result = fixture();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter(c => c.tool === "security").map(c => c.args)).toEqual([["find-identity", "-v", "-p", "codesigning"]]);
    expect(result.calls.filter(c => c.tool === "codesign").every(c => !c.args.includes("--keychain"))).toBe(true);
    expect(result.stdout).toContain("Signing complete");
  });
  it("keeps an isolated keychain with spaces scoped to lookup and every signing operation", () => {
    const result = fixture({ keychain: "present" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.find(c => c.tool === "security")?.args).toEqual(["find-identity", "-v", "-p", "codesigning", result.keychain]);
    const signs = result.calls.filter(c => c.tool === "codesign" && c.args.includes("--force"));
    expect(signs).toHaveLength(3);
    for (const call of signs) expect(call.args[call.args.indexOf("--keychain") + 1]).toBe(result.keychain);
  });
  it("rejects a missing keychain before invoking signing tools", () => {
    const result = fixture({ keychain: "missing" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HQ_SIGN_KEYCHAIN does not exist");
    expect(result.calls).toEqual([]);
  });
  it("refuses an unavailable identity before signing", () => {
    const result = fixture({ identity: "Different Identity" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found in the selected keychain scope");
    expect(result.stderr).not.toContain("unbound variable");
    expect(result.calls.every(c => c.tool === "security")).toBe(true);
  });
  it("preserves signing failure diagnostics in the selected keychain", () => {
    const result = fixture({ keychain: "present", failSign: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixture signing failure");
    const lookups = result.calls.filter(c => c.tool === "security");
    expect(lookups).toHaveLength(2);
    expect(lookups.every(c => c.args.at(-1) === result.keychain)).toBe(true);
  });
  it("keeps explicit ad-hoc signing independent of certificate lookup", () => {
    const result = fixture({ adHoc: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(c => c.tool === "security")).toBe(false);
  });
});
