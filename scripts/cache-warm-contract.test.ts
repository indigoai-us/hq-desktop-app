import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/cache-warm.yml", import.meta.url), "utf8");

function jobBody(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`cache-warm.yml is missing the ${name} job`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("cache-warm.yml prebuilt-shell warmers", () => {
  const jobs = [
    { job: "warm-shell-macos", target: "macos", ext: "tar.gz" },
    { job: "warm-shell-windows-x64", target: "windows-x64", ext: "tar" },
    { job: "warm-shell-windows-arm64", target: "windows-arm64", ext: "tar" },
  ];

  it("runs on main pushes that can change the shell key, and on dispatch", () => {
    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
    expect(workflow).toContain('- "scripts/shell-hash.mjs"');
    expect(workflow).toContain('- "crates/**"');
    expect(workflow).toContain("workflow_dispatch:");
  });

  for (const { job, target, ext } of jobs) {
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
