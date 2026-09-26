import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/cache-warm.yml", import.meta.url), "utf8");
const pinnedAction = readFileSync(
  new URL("../.github/actions/pinned-rust-toolchain/action.yml", import.meta.url),
  "utf8",
);

function jobBody(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`cache-warm.yml is missing the ${name} job`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("cache-warm.yml prebuilt-shell warmers", () => {
  const jobs = [
    { job: "warm-shell-macos", target: "macos", ext: "tar.gz", triples: "aarch64-apple-darwin,x86_64-apple-darwin" },
    { job: "warm-shell-windows-x64", target: "windows-x64", ext: "tar", triples: "x86_64-pc-windows-msvc" },
    { job: "warm-shell-windows-arm64", target: "windows-arm64", ext: "tar", triples: "aarch64-pc-windows-msvc" },
  ];

  it("runs on main pushes that can change the shell key, and on dispatch", () => {
    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
    expect(workflow).toContain('- "scripts/shell-hash.mjs"');
    expect(workflow).toContain('- "crates/**"');
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("lets an in-progress warm finish instead of cancelling it on the next push", () => {
    expect(workflow).toMatch(/concurrency:\n\s+group: .*\n\s+cancel-in-progress: false/);
    expect(workflow).not.toContain("cancel-in-progress: true");
  });

  it("pinned-rust-toolchain installs targets on the pinned toolchain and verifies them", () => {
    expect(pinnedAction).toContain("toolchain: ${{ inputs.toolchain }}");
    expect(pinnedAction).toContain("targets: ${{ inputs.targets }}");
    expect(pinnedAction).toContain("rustup target list --installed");
    expect(pinnedAction).toContain("is not installed on toolchain");
  });

  for (const { job, target, ext, triples } of jobs) {
    it(`${job} installs its targets on the same toolchain RUSTUP_TOOLCHAIN pins`, () => {
      const body = jobBody(job);
      expect(body).toContain('echo "toolchain=$TOOLCHAIN"');
      const pin = body.indexOf('echo "RUSTUP_TOOLCHAIN=$TOOLCHAIN" >> "$GITHUB_ENV"');
      const install = body.indexOf("uses: ./.github/actions/pinned-rust-toolchain");
      const build = body.indexOf("pnpm tauri build");
      expect(pin).toBeGreaterThan(-1);
      expect(install).toBeGreaterThan(pin);
      expect(build).toBeGreaterThan(install);
      const step = body.slice(install, body.indexOf("\n\n", install));
      expect(step).toContain("toolchain: ${{ steps.key.outputs.toolchain }}");
      expect(step).toContain(`targets: ${triples}`);
      // A "stable"-channel install after the pin would put targets on the wrong toolchain.
      expect(body.slice(pin)).not.toMatch(/toolchain: stable/);
    });


    it(`${job} stores only its own target's shell, keyed like release.yml`, () => {
      const body = jobBody(job);
      const others = jobs.filter((j) => j.target !== target).map((j) => `shell-${j.target}-`);
      for (const other of others) expect(body).not.toContain(other);
      expect(body).toContain(`ASSET="shell-${target}-\${SHELL_KEY}.${ext}"`);
      expect(body).toContain(`key: shell-${target}-\${{ steps.key.outputs.key }}`);
      expect(body).toContain("node scripts/shell-hash.mjs --root");
      // No-op when the shell-cache release already holds this key.
      expect(body).toContain("already-warm=true");
      expect(body).toContain('echo "RUSTUP_TOOLCHAIN=$TOOLCHAIN" >> "$GITHUB_ENV"');
      expect(body).toContain("HQ_BUILD_COMMIT=");
      expect(body).toContain(`node scripts/prune-shell-cache.mjs --target ${target} --keep 6`);
      if (ext === "tar") expect(body).toContain("tar --force-local -C src-tauri -cf");
    });
  }
});
