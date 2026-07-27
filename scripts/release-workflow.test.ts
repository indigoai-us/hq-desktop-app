import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let workflow = "";
let clientClassifier = "";
let windowsConfig = "";
let windowsCheckWorkflow = "";

beforeAll(async () => {
  [workflow, clientClassifier, windowsConfig, windowsCheckWorkflow] = await Promise.all([
    readFile(resolve(rootDir, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(rootDir, "crates/hq-desktop-core/src/release_channel.rs"), "utf8"),
    readFile(resolve(rootDir, "apps/sync/src-tauri/tauri.windows.conf.json"), "utf8"),
    readFile(resolve(rootDir, ".github/workflows/windows-check.yml"), "utf8"),
  ]);
});

function jobBody(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\n  ${escaped}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`,
  ).exec(workflow);

  if (!match) {
    throw new Error(`release workflow is missing the ${name} job`);
  }

  return match[1];
}

function classifierPatterns(): RegExp[] {
  const validate = jobBody("validate");
  return [...validate.matchAll(/\[\[ "\$TAG" =~ (\^\S+\$) \]\]/g)]
    .map((match) => new RegExp(match[1]));
}

describe("release workflow channel contract", () => {
  it("requires workflow_dispatch to name an existing strict release tag", () => {
    const dispatch = workflow.slice(0, workflow.indexOf("\njobs:"));

    expect(dispatch).toContain("workflow_dispatch:");
    expect(dispatch).toMatch(/tag:\n\s+description:.*Existing tag/);
    expect(dispatch).toMatch(/tag:[\s\S]*?required: true/);
    expect(jobBody("validate")).toContain(
      "ref: refs/tags/${{ steps.classify.outputs.tag }}",
    );
    expect(workflow).not.toContain("github.event.inputs.tag || github.ref");
  });

  it("accepts only the tag shapes understood by the Rust client classifier", () => {
    const patterns = classifierPatterns();
    const accepted = [
      "v0.10.35",
      "v0.10.35-beta.0",
      "v0.10.35-beta.1",
      "v0.10.35-beta.42",
      "v0.10.35-alpha.1",
    ];
    const rejected = [
      "0.10.35",
      "v0.10",
      "v0.10.35-beta",
      "v0.10.35-beta.x",
      "v0.10.35-beta.1.2",
      "v0.10.35-alpha",
      "v0.10.35-rc.1",
      "v0.10.35-pre.1",
      "v0.10.35-dev",
      "v0.10.35+manual",
      "v0.10.35-beta.1+manual",
      "v00.10.35",
      "v0.010.35",
      "v0.10.035",
      "v0.10.35-beta.01",
      "v0.10.35-alpha.00",
    ];

    expect(patterns.map((pattern) => pattern.source)).toEqual([
      "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
      "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-beta\\.(0|[1-9][0-9]*)$",
      "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-alpha\\.(0|[1-9][0-9]*)$",
    ]);

    for (const tag of accepted) {
      expect(patterns.filter((pattern) => pattern.test(tag)), tag).toHaveLength(1);
    }
    for (const tag of rejected) {
      expect(patterns.some((pattern) => pattern.test(tag)), tag).toBe(false);
    }

    expect(clientClassifier).toContain("vX.Y.Z-beta.N");
    expect(clientClassifier).toContain("vX.Y.Z-alpha.N");
    expect(clientClassifier).toContain("tag.strip_prefix('v')?");
    expect(clientClassifier).toContain("if !version.build.is_empty()");
    expect(clientClassifier).toContain("if pre_ids.len() != 2");
    expect(clientClassifier).toContain('pre_ids[1].parse::<u64>()');
  });

  it("requires the exact tag commit to be merged into main", () => {
    const validate = jobBody("validate");

    expect(validate).toContain(
      'git -C "$GITHUB_WORKSPACE" fetch --no-tags origin',
    );
    expect(validate).toContain(
      '"${TAG}^{commit}" refs/remotes/origin/main',
    );
    expect(validate).toContain(
      "Release tag $TAG is not contained in origin/main",
    );
  });

  it("allows an equal stable rerun but rejects a rollback below public latest", () => {
    const validate = jobBody("validate");

    expect(validate).toContain(
      "if: ${{ steps.classify.outputs.channel == 'stable' }}",
    );
    expect(validate).toContain(
      "`https://api.github.com/repos/${repository}/releases/latest`",
    );
    expect(validate).toContain(
      "const comparison = compareStableTags(targetTag, latestTag)",
    );
    expect(validate).toContain("if (comparison < 0)");
    expect(validate).toContain("Refusing stable rollback");
    expect(validate).toContain("if (comparison === 0)");
    expect(validate).toContain("allowing intentional rerun");
  });

  it("classifies stable separately from beta and alpha", () => {
    const validate = jobBody("validate");

    expect(validate).toMatch(
      /CHANNEL="stable"[\s\S]*?PRERELEASE="false"[\s\S]*?MAKE_LATEST="true"/,
    );
    expect(validate).toMatch(
      /CHANNEL="beta"[\s\S]*?PRERELEASE="true"[\s\S]*?MAKE_LATEST="false"/,
    );
    expect(validate).toMatch(
      /CHANNEL="alpha"[\s\S]*?PRERELEASE="true"[\s\S]*?MAKE_LATEST="false"/,
    );

    for (const output of [
      "tag",
      "version",
      "channel",
      "prerelease",
      "make_latest",
      "msi_version",
    ]) {
      expect(workflow).toContain(
        output === "msi_version"
          ? "msi_version: ${{ steps.msi-version.outputs.version }}"
          : `${output}: \${{ steps.classify.outputs.${output} }}`,
      );
    }
  });

  it("gates both platform builds on versions.toml and all four stamped files", () => {
    const validate = jobBody("validate");

    for (const file of [
      "versions.toml",
      "apps/sync/package.json",
      "apps/sync/src-tauri/tauri.conf.json",
      "apps/sync/src-tauri/Cargo.toml",
      "apps/sync/src-tauri/Cargo.lock",
    ]) {
      expect(validate).toContain(file);
    }

    expect(jobBody("macos")).toContain("needs: validate");
    expect(jobBody("windows")).toContain("needs: validate");
    expect(workflow.match(/ref: refs\/tags\//g)).toHaveLength(4);
  });

  it("publishes prereleases without advancing the stable latest alias", () => {
    const publish = jobBody("publish");

    expect(publish).toContain("needs: [validate, macos, windows]");
    expect(publish).toContain(
      "needs.macos.result == 'success' && needs.windows.result == 'success'",
    );
    expect(publish).not.toContain("needs.windows.result == 'failure'");
    expect(publish).toContain("Validate complete release artifact set");
    expect(publish).not.toContain("simply omitted");
    expect(publish).not.toContain("skip (missing)");
    expect(publish).toContain('VERSION="${TAG#v}"');
    for (const artifact of [
      "arm64-setup.exe",
      "arm64-setup.exe.sig",
      "arm64.msi",
      "arm64.msi.sig",
      "universal.app.tar.gz",
      "universal.app.tar.gz.sig",
      "universal.dmg",
      "x64-setup.exe",
      "x64-setup.exe.sig",
      "x64.msi",
      "x64.msi.sig",
    ]) {
      expect(publish).toContain(artifact);
    }
    expect(publish).toContain(
      "tag_name: ${{ needs.validate.outputs.tag }}",
    );
    expect(publish).toContain(
      "prerelease: ${{ needs.validate.outputs.prerelease }}",
    );
    expect(publish).toContain(
      "make_latest: ${{ needs.validate.outputs.make_latest }}",
    );
  });

  it("gives WiX a numeric MSI ProductVersion while preserving app SemVer", () => {
    const windows = jobBody("windows");

    expect(windows).toContain("Generate Windows MSI version overlay");
    expect(windows).toContain(
      "node ../../scripts/windows-msi-version.mjs",
    );
    expect(windows).toContain(
      "--config $env:TAURI_MSI_VERSION_CONFIG",
    );
    expect(windows).toContain("--bundles msi nsis updater");
    expect(windows).toContain("Required updater signature is missing");
    expect(windows.indexOf("--config src-tauri/tauri.windows.release.conf.json")).toBeLessThan(
      windows.indexOf("--config $env:TAURI_MSI_VERSION_CONFIG"),
    );
    expect(JSON.parse(windowsConfig).bundle.windows.allowDowngrades).toBe(false);
  });

  it("builds a prerelease MSI in the regular Windows installer gate", () => {
    expect(windowsCheckWorkflow).toContain("installer E2E (x64 MSI + NSIS)");
    expect(windowsCheckWorkflow).toContain("Generate Windows MSI version overlay");
    expect(windowsCheckWorkflow).toContain(
      "node ../../scripts/windows-msi-version.mjs",
    );
    expect(windowsCheckWorkflow).toContain("--bundles msi nsis");
    expect(windowsCheckWorkflow).toContain("Verify prerelease MSI package");
    expect(windowsCheckWorkflow).toContain(
      "--config $env:TAURI_MSI_VERSION_CONFIG",
    );
  });
});
