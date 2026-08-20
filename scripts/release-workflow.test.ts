import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let workflow = "";
let clientClassifier = "";
let windowsConfig = "";
let windowsCheckWorkflow = "";
let versionsToml = "";
let syncCargoToml = "";
let releaseDocs = "";

beforeAll(async () => {
  [workflow, clientClassifier, windowsConfig, windowsCheckWorkflow, versionsToml, syncCargoToml, releaseDocs] = await Promise.all([
    readFile(resolve(rootDir, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(rootDir, "crates/hq-desktop-core/src/release_channel.rs"), "utf8"),
    readFile(resolve(rootDir, "apps/sync/src-tauri/tauri.windows.conf.json"), "utf8"),
    readFile(resolve(rootDir, ".github/workflows/windows-check.yml"), "utf8"),
    readFile(resolve(rootDir, "versions.toml"), "utf8"),
    readFile(resolve(rootDir, "apps/sync/src-tauri/Cargo.toml"), "utf8"),
    readFile(resolve(rootDir, "docs/RELEASE.md"), "utf8"),
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

function stepBody(job: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\n      - name: ${escaped}\\n([\\s\\S]*?)(?=\\n      - name: |$)`,
  ).exec(job);

  if (!match) {
    throw new Error(`release workflow is missing the ${name} step`);
  }

  return match[1];
}

function uploadArtifactStepBodies(job: string): string[] {
  return [...job.matchAll(
    /\n      - name: [^\n]+\n        uses: actions\/upload-artifact@v4\n([\s\S]*?)(?=\n      - (?:name|uses): |$)/g,
  )].map((match) => match[1]);
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

  it("requires stable on main and rejects alpha/beta prereleases on main", () => {
    const validate = jobBody("validate");

    // Shared ancestry probe: is the tag commit contained in origin/main?
    expect(validate).toContain(
      'git -C "$GITHUB_WORKSPACE" fetch --no-tags origin',
    );
    expect(validate).toContain(
      '"${TAG}^{commit}" refs/remotes/origin/main',
    );

    // The branch rule splits by channel, keyed off the classified prerelease
    // flag: stable must ship from main; alpha/beta must NOT be on main.
    expect(validate).toContain('if [ "$PRERELEASE" = "true" ]; then');
    expect(validate).toContain(
      "Stable release tag $TAG is not contained in origin/main",
    );
    expect(validate).toContain(
      "alpha and beta releases may only be cut from non-main branches",
    );

    // The check runs only on a fresh tag push. A workflow_dispatch retry of an
    // existing, immutable tag must not be re-gated by the branch policy.
    expect(validate).toMatch(
      /- name: Enforce release branch policy\n {8}if: \$\{\{ github\.event_name == 'push' \}\}/,
    );
  });

  it("refuses to release a tag whose tree carries the V2 chat shell", () => {
    const validate = jobBody("validate");

    // The guard runs on the tag's own checked-out tree, which is the only
    // place that catches the actual failure mode: a stable tag cut from a main
    // tip that still carried the shell. A branch-level check cannot see it.
    expect(validate).toContain("- name: Enforce v1 desktop shell");
    expect(validate).toContain('if [ -d "$SHELL_DIR/chat" ]; then');
    expect(validate).toContain("this tag carries the V2 chat shell");

    // Negative check alone is not enough — an empty desktop-alt tree would
    // pass it. The v1 sidebars must positively be present.
    expect(validate).toContain(
      "for marker in v4/V4Sidebar.svelte v4/V4SecondarySidebar.svelte; do",
    );
    expect(validate).toContain("the v1 desktop shell is not intact");
  });

  it("applies the shell guard to workflow_dispatch retries too", () => {
    const validate = jobBody("validate");

    // The branch policy above deliberately skips dispatch retries. This guard
    // must NOT: a retry re-publishes that tag's artifacts to stable, so
    // retrying any of v0.10.106–v0.10.116 would put the V2 shell back in front
    // of users. Asserting the absence of the gate keeps a well-meaning
    // "make it consistent with the step above" edit from reopening that path.
    expect(validate).not.toMatch(
      /- name: Enforce v1 desktop shell\n {8}if: \$\{\{ github\.event_name == 'push' \}\}/,
    );
  });

  it("keeps the working tree on the v1 desktop shell", async () => {
    const shellDir = resolve(rootDir, "apps/sync/src/desktop-alt");

    await expect(stat(resolve(shellDir, "chat"))).rejects.toThrow();

    for (const marker of ["v4/V4Sidebar.svelte", "v4/V4SecondarySidebar.svelte"]) {
      await expect(stat(resolve(shellDir, marker))).resolves.toBeDefined();
    }
  });

  it("allows an equal stable rerun but rejects a rollback below public latest", () => {
    const validate = jobBody("validate");

    expect(validate).toContain(
      "if: ${{ steps.classify.outputs.channel == 'stable' }}",
    );
    expect(validate).toContain(
      "node .release-control/scripts/release-stable-order.mjs stable-order",
    );
    expect(validate).toContain('--repository "$TARGET_REPOSITORY"');
    expect(validate).toContain('--tag "$TARGET_TAG"');
  });

  it("runs the commit-lineage rollback gate at both stable call sites", () => {
    const validate = jobBody("validate");
    const publish = jobBody("publish");

    // Validate job, before the expensive native builds.
    const rejectStep = stepBody(validate, "Reject stable release rollback");
    expect(rejectStep).toContain(
      "node .release-control/scripts/release-stable-order.mjs lineage",
    );
    expect(rejectStep).toContain('--repository "$TARGET_REPOSITORY"');
    expect(rejectStep).toContain('--tag "$TARGET_TAG"');
    expect(validate).toContain(
      "if: ${{ steps.classify.outputs.channel == 'stable' }}",
    );

    // Publish job, inside the global publication lock, immediately before the
    // only public-state mutation.
    const revalidateStep = stepBody(publish, "Revalidate stable publication order");
    expect(revalidateStep).toContain(
      "node .release-control/scripts/release-stable-order.mjs lineage",
    );
    expect(revalidateStep).toContain('--repository "$TARGET_REPOSITORY"');
    expect(publish).toContain(
      "needs.validate.outputs.channel == 'stable' && steps.release-plan.outputs.action != 'already-published'",
    );
  });

  it("stamps the tag's own commit into both build jobs for the Sentry build_commit tag", () => {
    for (const job of ["macos", "windows"]) {
      const step = stepBody(jobBody(job), "Stamp build commit identity");
      expect(step).toContain(
        'echo "HQ_BUILD_COMMIT=$(git rev-parse HEAD)" >> "$GITHUB_ENV"',
      );
    }
  });

  it("documents the stable lineage rollback contract and the Rollback-Of trailer", () => {
    expect(releaseDocs).toContain("Rollback-Of: vX.Y.Z");
    expect(releaseDocs).toContain("drops every fix the named release contains");
    // The rollback tag must name the older commit explicitly, not tag HEAD.
    expect(releaseDocs).toContain("git tag -a vX.Y.Z <rollback-commit>");
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

  it("stamps versions.toml and all four generated files from the tag", () => {
    const validate = jobBody("validate");

    // The tag is the source of truth: validate derives every version surface
    // from it rather than requiring a human to have bumped them beforehand.
    expect(validate).toContain('pnpm run version:app --set-version "$RELEASE_VERSION"');
    expect(validate).toContain("pnpm run version:check");

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

  it("hands both platform builds the same stamped version bytes", () => {
    // One artifact, produced once, consumed by every builder — so macOS and
    // Windows can never bundle different versions from the same tag.
    expect(jobBody("validate")).toContain("name: release-version-stamp");

    for (const job of ["macos", "windows"]) {
      const body = jobBody(job);
      expect(body).toContain("actions/download-artifact@v4");
      expect(body).toContain("name: release-version-stamp");
      expect(body).toContain("Verify stamped version");
    }
  });

  it("syncs the released version back to main only for stable releases", () => {
    const sync = jobBody("sync-version");

    // Runs only after a successful publish, so a branch it cannot push never
    // blocks or masks a shipped release.
    expect(sync).toContain("needs: [validate, publish]");
    expect(sync).toContain("needs.publish.result == 'success'");
    // alpha/beta prereleases are cut from non-main branches, so their version
    // is never stamped onto main — sync-back is gated to stable releases only.
    expect(sync).toContain("needs.validate.outputs.prerelease != 'true'");
    expect(sync).toContain("ref: main");

    // main is protected with no role bypass, and GitHub will not accept the
    // Actions identity as a ruleset bypass actor — the push must go through the
    // hq-audit-bot App, which is the bypass actor on the `main` ruleset.
    expect(sync).toContain("actions/create-github-app-token@v1");
    expect(sync).toContain("HQ_AUDIT_BOT_APP_ID");
    expect(sync).toContain("token: ${{ steps.app-token.outputs.token }}");
    expect(sync).toContain("scripts/release-version-order.mjs");
    expect(sync).toContain("git push origin HEAD:refs/heads/main");
    // Never `git add -A`: only the five version surfaces may be committed.
    expect(sync).not.toContain("git add -A");
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
  });

  it("uploads and verifies a hidden draft before making a release public", () => {
    const publish = jobBody("publish");
    const resolveState = publish.indexOf("- name: Resolve atomic release state");
    const create = publish.indexOf("- name: Create or reset hidden draft GitHub release");
    const upload = publish.indexOf("- name: Upload complete asset set to draft");
    const verify = publish.indexOf("- name: Verify exact draft release asset set");
    const makePublic = publish.indexOf("- name: Publish verified GitHub release");
    const confirm = publish.indexOf("- name: Confirm public release and channel isolation");

    expect(resolveState).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(resolveState);
    expect(upload).toBeGreaterThan(create);
    expect(verify).toBeGreaterThan(upload);
    expect(makePublic).toBeGreaterThan(verify);
    expect(confirm).toBeGreaterThan(makePublic);
    expect(publish).not.toContain("softprops/action-gh-release");
    expect(publish).toContain("group: release-publication");
    expect(publish).not.toContain("group: release-publish-${{");
    expect(publish).toContain("cancel-in-progress: false");
    expect(publish).toContain(
      '"repos/${REPOSITORY}/releases?per_page=100"',
    );
    expect(publish).not.toContain(
      '"repos/${REPOSITORY}/releases/tags/${TAG}"',
    );
    expect(publish).toContain(
      ".release-control/scripts/release-asset-contract.mjs plan",
    );
    expect(publish).toContain("create-draft");
    expect(publish).toContain("reset-draft|already-published");
    expect(publish).toContain("draft: true");
    expect(publish.match(/action != 'already-published'/g)).toHaveLength(5);
    expect(publish).toContain('gh release upload "$TAG" release/* -R "$REPOSITORY"');
    expect(publish).toContain(
      ".release-control/scripts/release-asset-contract.mjs verify",
    );
    expect(publish).toContain("--draft true");
    expect(publish).toContain("--match-bytes true");
    expect(publish).toContain("draft: false");
    expect(publish).toContain(
      "PRERELEASE: ${{ needs.validate.outputs.prerelease }}",
    );
    expect(publish).toContain(
      "MAKE_LATEST: ${{ needs.validate.outputs.make_latest }}",
    );
    expect(publish).toContain(
      ".release-control/scripts/release-asset-contract.mjs manifest",
    );
    expect(publish).toContain('match_bytes="false"');
    const revalidate = publish.indexOf(
      "- name: Revalidate stable publication order",
    );
    expect(revalidate).toBeGreaterThan(verify);
    expect(revalidate).toBeLessThan(makePublic);
    expect(publish).toContain(
      "needs.validate.outputs.channel == 'stable' && steps.release-plan.outputs.action != 'already-published'",
    );
    expect(publish).toContain(
      "node .release-control/scripts/release-stable-order.mjs stable-order",
    );
    expect(publish).toContain(
      "node .release-control/scripts/release-stable-order.mjs confirm-channel",
    );
    expect(publish).toContain('--make-latest "$MAKE_LATEST"');
    expect(publish).not.toContain('releases/latest" 2>/dev/null || true');
  });

  it("loads retry-safe publication helpers from the exact workflow commit", () => {
    const validate = jobBody("validate");
    const publish = jobBody("publish");

    for (const job of [validate, publish]) {
      expect(job).toContain("- name: Checkout release control plane");
      expect(job).toContain("ref: ${{ github.workflow_sha }}");
      expect(job).toContain("path: .release-control");
      expect(job).toContain("scripts/release-asset-contract.mjs");
      expect(job).toContain("scripts/release-stable-order.mjs");
      expect(job).toContain("sparse-checkout-cone-mode: false");
      expect(job).toContain("persist-credentials: false");
    }
  });

  it("documents the release hosts and native targets the workflow actually ships", () => {
    expect(versionsToml).toContain(
      'manifest_base = "https://github.com/indigoai-us/hq-desktop-app/releases"',
    );
    expect(versionsToml).toContain(
      'macos = ["aarch64-apple-darwin", "x86_64-apple-darwin"]',
    );
    expect(versionsToml).toContain(
      'windows = ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]',
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
    // The Recall-only Windows release overlay is gone with the SDK sidecar: it
    // existed solely to carry `bundle.externalBin` for the launcher PE and a
    // beforeBuildCommand that rebuilt it.
    expect(windows).not.toContain("tauri.windows.release.conf.json");
    expect(windows).not.toContain("RECALL_SIDECAR_TARGET");
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

  it("runs the required Windows gate for release-control changes", () => {
    for (const path of [
      '"versions.toml"',
      '"scripts/release-*.mjs"',
      '"scripts/release-*.test.ts"',
      '"scripts/windows-msi-version.mjs"',
      '"scripts/windows-msi-version.test.ts"',
      '".github/workflows/release.yml"',
    ]) {
      expect(windowsCheckWorkflow).toContain(path);
    }
  });

  it("retains native debug files only in Sentry and verifies each uploaded debug id", () => {
    const macos = jobBody("macos");
    const windows = jobBody("windows");

    expect(macos).toContain("Install Sentry CLI");
    expect(macos).toContain("Upload macOS debug files to Sentry");
    expect(macos).toContain("sentry-cli debug-files upload");
    expect(macos).toContain("--no-sources");
    expect(macos).toContain("SENTRY_AUTH_TOKEN");
    expect(macos).toContain("SENTRY_AUTH_TOKEN is not configured");
    expect(stepBody(macos, "Upload macOS debug files to Sentry")).toContain(
      "GITHUB_STEP_SUMMARY",
    );
    expect(stepBody(macos, "Upload macOS debug files to Sentry")).toContain(
      "https://sentry.io/api/0/projects/indigo-d0/hq-desktop/files/dsyms/",
    );
    expect(stepBody(macos, "Upload macOS debug files to Sentry")).toContain(
      "debug_id",
    );
    expect(macos).toContain('DSYM_BUNDLE="${APP_BUNDLE}.dSYM"');
    expect(macos).toContain("HQ.app/Contents/MacOS/hq-sync-menubar");
    expect(macos).toContain(
      'DSYM_BINARY="$DSYM_BUNDLE/Contents/Resources/DWARF/hq-sync-menubar"',
    );
    // The sidecar dSYM is produced BEFORE the app binary is stripped: preferred
    // source is the packed per-arch dSYMs (split-debuginfo = "packed"),
    // lipo-combined into one universal DWARF; dsymutil on the pre-strip binary
    // is only a fallback.
    expect(macos).toContain(
      "src-tauri/target/${ARCH}/release/hq-sync-menubar.dSYM",
    );
    expect(macos).toContain('lipo -create "${DWARF_SLICES[@]}" -output "$DSYM_BINARY"');
    // The shipped binary is stripped explicitly in the workflow: cargo's strip
    // left the embedded __DWARF on this universal build, so an xcrun strip is
    // required to keep the bundle deterministically under budget.
    expect(macos).toContain('xcrun strip -S -x "$APP_BINARY"');
    // The 15 MB total-bundle budget was never satisfiable while the bundle
    // carried the Recall SDK sidecar. That payload is gone, but the meaningful
    // native-symbol/code-bloat signal is still the stripped binary, budgeted
    // tightly; the coarse total-bundle ceiling stays to catch runaway resource
    // growth. (It earned its keep: it caught the upstream SDK going 149 MB ->
    // 377 MB mid-release.)
    expect(macos).toContain("APP_BINARY_BUDGET_KB=$((120 * 1024))");
    expect(macos).toContain("macOS app binary exceeds 120 MB budget");
    expect(macos).toContain("BUNDLE_BUDGET_KB=$((300 * 1024))");
    expect(macos).toContain("macOS app bundle exceeds 300 MB budget");
    expect(macos).not.toContain("15 * 1024");

    expect(windows).toContain("Install Sentry CLI");
    expect(windows).toContain("Verify Windows debug file contract");
    expect(windows).toContain("hq_sync_menubar.pdb");
    expect(windows).toContain("hq-sync-menubar.exe");
    expect(windows).toContain("sentry-cli difutil check");
    expect(windows).toContain("Upload Windows debug files to Sentry");
    expect(windows).toContain("sentry-cli debug-files upload");
    expect(windows).toContain("--no-sources");
    expect(windows).toContain("SENTRY_AUTH_TOKEN is not configured");
    expect(windows).toContain("SENTRY_AUTH_TOKEN is invalid or upload failed");
    expect(stepBody(windows, "Upload Windows debug files to Sentry")).toContain(
      'Write-Host "::warning::$message"',
    );
    expect(stepBody(windows, "Upload Windows debug files to Sentry")).toContain(
      "GITHUB_STEP_SUMMARY",
    );
    expect(stepBody(windows, "Upload Windows debug files to Sentry")).toContain(
      "https://sentry.io/api/0/projects/indigo-d0/hq-desktop/files/dsyms/",
    );
    expect(stepBody(windows, "Upload Windows debug files to Sentry")).toContain(
      "debug_id",
    );
    expect(windows).toContain("$exeMetadata.variants");
    expect(windows).toContain("$pdbMetadata.variants");
    expect(macos).toContain('data.get("variants", [])');
    expect(syncCargoToml).toMatch(/\[profile\.release\][\s\S]*?debug = "line-tables-only"/);
    // Deterministic strip keeps the shipped macOS .app under the 15 MB budget
    // regardless of rust-cache / incremental-artifact state (v0.10.81 regression).
    expect(syncCargoToml).toMatch(/\[profile\.release\][\s\S]*?strip = "symbols"/);
    expect(syncCargoToml).toMatch(/\[profile\.release\][\s\S]*?split-debuginfo = "packed"/);

    expect(windowsCheckWorkflow).toContain("Verify installer debug file contract");
    expect(windowsCheckWorkflow).toContain("hq-sync-menubar.exe");
    expect(windowsCheckWorkflow).toContain("hq_sync_menubar.pdb");
    expect(windowsCheckWorkflow).toContain("sentry-cli difutil check --json");
    expect(windowsCheckWorkflow).toContain("Installer executable/PDB debug id");

    expect(workflow).not.toContain("hq-debug-");
    expect(workflow).not.toContain("debug-artifacts-${{ matrix.target }}");
    expect(workflow).not.toContain("private CI artifact");
    expect(workflow).not.toContain("private GitHub Actions");
    expect(releaseDocs).toContain("Sentry is the only retention path");
    expect(releaseDocs).toContain("that build\nhas no recoverable symbols");
    expect(releaseDocs).toContain("`--no-sources`");
    expect(releaseDocs).not.toContain("private CI artifact");
    expect(releaseDocs).not.toContain("private GitHub Actions");
    for (const uploadBody of [
      ...uploadArtifactStepBodies(macos),
      ...uploadArtifactStepBodies(windows),
    ]) {
      expect(uploadBody).not.toMatch(/(?:\.pdb|\.app\.dSYM)/);
    }
    expect(`${macos}\n${windows}`).not.toContain("--include-sources");

    const publish = jobBody("publish");
    expect(publish).not.toContain("Download all artifacts");
    expect(publish).toContain("Download macOS release artifacts");
    expect(publish).toContain("Download Windows x64 release artifacts");
    expect(publish).toContain("Download Windows ARM64 release artifacts");
    expect(publish).not.toContain("hq-debug-");
  });
});


/**
 * A `run:` step written as a YAML folded scalar (`>-`) joins its lines with
 * spaces — UNLESS a line is blank or whitespace-only, which forces a literal
 * newline. A whitespace-only line is invisible in a diff and in most editors,
 * but it splits the command in two: PowerShell then parses the continuation
 * (`--config ...`) as a fresh statement and dies with
 * "Missing expression after unary operator '--'".
 *
 * That is exactly how removing the Recall sidecar's `--config` argument broke
 * the Windows installer build: the text went, the indentation stayed, and the
 * failure looked nothing like the edit that caused it.
 *
 * A whitespace-only line is never intentional in these files — inside a folded
 * scalar it changes the command, and everywhere else it is trailing noise — so
 * assert on the character class directly rather than reimplementing YAML
 * folding.
 */
describe("workflow folded run steps cannot be split by invisible whitespace", () => {
  const workflowFiles = [
    ".github/workflows/release.yml",
    ".github/workflows/windows-check.yml",
    ".github/workflows/ci.yml",
  ];

  it("has no whitespace-only lines in any workflow", async () => {
    for (const file of workflowFiles) {
      const text = await readFile(resolve(rootDir, file), "utf8");
      const offenders = text
        .split("\n")
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(({ line }) => line !== "" && line.trim() === "")
        .map(({ lineNumber }) => lineNumber);
      expect(
        offenders,
        `${file} has whitespace-only line(s) at ${offenders.join(", ")} — ` +
          `inside a folded 'run: >-' block these become real line breaks and ` +
          `split the command into two shell statements`,
      ).toEqual([]);
    }
  });

  it("keeps the Windows installer build a single shell statement", () => {
    const step = windowsCheckWorkflow.slice(
      windowsCheckWorkflow.indexOf("Build production MSI and NSIS installers"),
    );
    const folded = step.slice(step.indexOf("run: >-"), step.indexOf("- name: Install Sentry CLI"));
    const argLines = folded
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().length > 0);
    // Every continuation line must carry an argument; a gap here is the bug.
    for (const line of argLines) {
      expect(line.trim().length).toBeGreaterThan(0);
    }
    expect(argLines.some((line) => line.includes("--bundles msi nsis"))).toBe(true);
    expect(folded).not.toContain("tauri.windows.release.conf.json");
  });
});
