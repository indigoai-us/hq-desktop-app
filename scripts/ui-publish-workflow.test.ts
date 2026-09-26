import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const uiPublishText = readFileSync(new URL("../.github/workflows/ui-publish.yml", import.meta.url), "utf8");
const releaseText = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

/** Text of one top-level job (from `  name:` to the next two-space key). */
function jobText(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`job ${name} not found`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Text of one step (from `- name: X` to the next `- name:`). */
function stepText(job: string, name: string): string {
  const start = job.indexOf(`- name: ${name}\n`);
  if (start < 0) throw new Error(`step ${name} not found`);
  const rest = job.slice(start);
  const next = rest.slice(1).search(/\n\s+- (name|uses):/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function needsOf(job: string): string {
  return /\n    needs: (.*)\n/.exec(job)?.[1] ?? "";
}

describe("ui-only publish workflow", () => {
  const runs = jobText(uiPublishText, "publish");

  it("never touches the app updater pointer or versioned releases", () => {
    expect(uiPublishText).not.toContain("latest.json\"");
    expect(runs).not.toMatch(/latest\.json(?!-)/);
    expect(runs).not.toMatch(/gh release (upload|edit|create) "?\$?\{?\{?\s*steps\.base/);
    expect(runs).toContain("gh release create ui-updates");
    expect(runs).toContain("--prerelease --latest=false");
  });

  it("refuses a ref whose native shell differs from the base release", () => {
    expect(runs).toContain('--root "$PWD/src" --toolchain compare --target compare');
    expect(runs).toContain('--root "$PWD/base" --toolchain compare --target compare');
    expect(runs).toContain("Ship a native release instead");
  });

  it("signs with the updater key and moves the pointer only after the archive is up", () => {
    expect(stepText(runs, "Sign UI bundle with the updater key")).toContain("signer sign");
    const pub = stepText(runs, "Publish to ui-updates");
    expect(pub.indexOf('"$ARCHIVE" "$ARCHIVE.sig"')).toBeGreaterThan(-1);
    expect(pub.indexOf('"$ARCHIVE" "$ARCHIVE.sig"')).toBeLessThan(pub.indexOf("ui-latest-$CHANNEL.json\" -R"));
  });

  it("offers only the beta and stable channels", () => {
    expect(uiPublishText).toMatch(/options: \[beta, stable\]/);
  });
});

describe("release.yml ui-bundle job", () => {
  const uiBundle = jobText(releaseText, "ui-bundle");

  it("runs after publication from the same ui-dist and shell keys", () => {
    for (const need of ["publish", "ui", "shell-key", "shell-windows-x64", "shell-windows-arm64"]) {
      expect(needsOf(uiBundle)).toMatch(new RegExp(`[\\[ ]${need}[,\\]]`));
    }
    expect(uiBundle).toContain("needs.publish.result == 'success'");
    const runs = uiBundle;
    expect(runs).toContain("scripts/ui-bundle.mjs pack");
    expect(runs).toContain("signer sign");
    expect(runs).toContain('gh release upload "$TAG"');
    expect(runs).not.toContain("latest.json");
  });

  it("is not a dependency of publish, so the product release never waits on it", () => {
    expect(needsOf(jobText(releaseText, "publish"))).not.toContain("ui-bundle");
  });
});
