/* global process */
// Tests for check-changelog.mjs. Zero dependencies: run with
//   node --test .github/scripts/check-changelog.test.mjs
// A guard that cannot be shown failing on the exact condition it exists to
// catch is not a guard, so every mode has a red case next to its green one.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkPullRequest,
  checkRelease,
  checkVersionPullRequest,
  parseSections,
  promoteReleased,
  releaseNotes,
} from "./check-changelog.mjs";

// The body of one section, as it reads in the file.
const section = (text, key) => (parseSections(text).get(key) ?? []).join("\n").trim();

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-changelog.mjs");

const EMPTY = `# Changelog

## [Unreleased]

## [1.2.0] — 2026-01-02

### Fixed

- Sync no longer stops when a file is renamed while it uploads.
`;

const WITH_ENTRY = EMPTY.replace(
  "## [Unreleased]\n",
  "## [Unreleased]\n\n### Added\n\n- A new example command. It never changes anything.\n",
);

// hq-pro-core style: bare version headings, no Unreleased section.
const BARE = `# Changelog

## 1.94.16

- Release the channel-message support merged in #124.

## 1.94.15

- Quiet the unreachable crawl-URL class.
`;

describe("pr: a pull request must add release notes", () => {
  it("fails a PR that leaves ## [Unreleased] empty", () => {
    const result = checkPullRequest(EMPTY, EMPTY);
    assert.equal(result.ok, false);
    assert.match(result.message, /no-changelog/);
  });

  it("passes a PR that adds an entry under ## [Unreleased]", () => {
    assert.equal(checkPullRequest(EMPTY, WITH_ENTRY).ok, true);
  });

  it("does not count entries other PRs already wrote", () => {
    assert.equal(checkPullRequest(WITH_ENTRY, WITH_ENTRY).ok, false);
  });

  it("does not count bare subheadings or HTML comments, including multi-line and unterminated ones", () => {
    const head = EMPTY.replace(
      "## [Unreleased]\n",
      "## [Unreleased]\n\n### Added\n\n<!-- TODO -->\n<!--\nTODO: write the notes\n-->\n<!-- unterminated\nplaceholder\n",
    );
    assert.equal(checkPullRequest(EMPTY, head).ok, false);
  });

  it("counts a note that shares a line with an HTML comment", () => {
    const head = EMPTY.replace("## [Unreleased]\n", "## [Unreleased]\n\n- A real note. <!-- from #123 -->\n");
    assert.equal(checkPullRequest(EMPTY, head).ok, true);
  });

  it("does not count edits to an already released section", () => {
    const head = EMPTY.replace("while it uploads.", "while it uploads, even on slow disks.");
    assert.equal(checkPullRequest(EMPTY, head).ok, false);
  });

  it("passes a PR that adds a new, non-empty release section", () => {
    const head = EMPTY.replace("## [1.2.0]", "## [1.3.0] — 2026-01-03\n\n- Something users will notice.\n\n## [1.2.0]");
    assert.equal(checkPullRequest(EMPTY, head).ok, true);
  });

  it("fails a PR that removes the ## [Unreleased] heading", () => {
    assert.equal(checkPullRequest(EMPTY, WITH_ENTRY.replace("## [Unreleased]\n", "")).ok, false);
  });

  it("fails a PR that deletes a note another change wrote", () => {
    const base = WITH_ENTRY.replace("anything.\n", "anything.\n- A second pending note.\n");
    const head = base.replace("- A second pending note.\n", "- This PR's own note.\n");
    const result = checkPullRequest(base, head);
    assert.equal(result.ok, false);
    assert.match(result.message, /removes or rewrites 1 existing note/);
    assert.match(result.message, /A second pending note/);
    assert.match(result.message, /no-changelog/);
  });

  it("fails a PR whose only change is rewording an existing note", () => {
    const head = WITH_ENTRY.replace("It never changes anything.", "It never changes a thing.");
    assert.equal(checkPullRequest(WITH_ENTRY, head).ok, false);
  });

  it("passes a PR that moves pending notes into a new release section intact", () => {
    const head = WITH_ENTRY.replace(
      "## [Unreleased]\n\n### Added\n\n- A new example command. It never changes anything.\n",
      "## [Unreleased]\n\n## [1.3.0] — 2026-01-03\n\n### Added\n\n- A new example command. It never changes anything.\n",
    );
    assert.equal(checkPullRequest(WITH_ENTRY, head).ok, true);
  });

  it("does not treat a heading inside a fenced code block as a section", () => {
    const head = EMPTY.replace(
      "## [Unreleased]\n",
      "## [Unreleased]\n\n- Config files now accept a heading block:\n\n```md\n## [Unreleased]\n## 9.9.9\n```\n",
    );
    assert.equal(checkPullRequest(EMPTY, head).ok, true);
    const notes = section(head, "Unreleased");
    assert.match(notes, /## 9\.9\.9\n```$/);
    assert.equal(parseSections(head).has("9.9.9"), false);
  });

  it("does not count fence markers alone as notes", () => {
    const head = EMPTY.replace("## [Unreleased]\n", "## [Unreleased]\n\n```\n```\n");
    assert.equal(checkPullRequest(EMPTY, head).ok, false);
  });
});

describe("pr-version: a version bump must carry notes for the new version", () => {
  it("fails a bump with no section for the new version", () => {
    const result = checkVersionPullRequest(BARE, BARE, "1.94.16", "1.94.17");
    assert.equal(result.ok, false);
    assert.match(result.message, /## 1\.94\.17/);
  });

  it("fails a bump whose new section is empty or only a comment", () => {
    const head = BARE.replace("## 1.94.16", "## 1.94.17\n\n<!-- TODO -->\n\n## 1.94.16");
    assert.equal(checkVersionPullRequest(BARE, head, "1.94.16", "1.94.17").ok, false);
  });

  it("passes a bump that adds notes for the new version", () => {
    const head = BARE.replace("## 1.94.16", "## 1.94.17\n\n- Fix a thing callers notice.\n\n## 1.94.16");
    assert.equal(checkVersionPullRequest(BARE, head, "1.94.16", "1.94.17").ok, true);
  });

  it("accepts a bracketed heading for the new version too", () => {
    const head = BARE.replace("## 1.94.16", "## [1.94.17]\n\n- Fix a thing.\n\n## 1.94.16");
    assert.equal(checkVersionPullRequest(BARE, head, "1.94.16", "1.94.17").ok, true);
  });

  it("passes a PR that does not change the version, because it publishes nothing", () => {
    assert.equal(checkVersionPullRequest(BARE, BARE, "1.94.16", "1.94.16").ok, true);
  });
});

describe("release: a release must not publish empty notes", () => {
  it("refuses when ## [Unreleased] is empty", () => {
    const result = checkRelease(EMPTY, "1.3.0");
    assert.equal(result.ok, false);
    assert.match(result.message, /blank release notes/);
  });

  it("allows when ## [Unreleased] has notes, and accepts a v-prefixed tag", () => {
    assert.equal(checkRelease(WITH_ENTRY, "v1.3.0").ok, true);
  });

  it("refuses when ## [Unreleased] holds only subheadings", () => {
    const text = EMPTY.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Added\n\n### Fixed\n");
    assert.equal(checkRelease(text, "1.3.0").ok, false);
  });

  it("refuses an empty section for the version even if Unreleased has notes", () => {
    const text = WITH_ENTRY.replace("## [1.2.0]", "## [1.3.0] — 2026-01-03\n\n## [1.2.0]");
    assert.equal(checkRelease(text, "1.3.0").ok, false);
  });

  it("allows a section for the version that has notes, bracketed or bare", () => {
    assert.equal(checkRelease(EMPTY, "1.2.0").ok, true);
    assert.equal(checkRelease(BARE, "1.94.15").ok, true);
  });

  it("refuses a bare-heading changelog with no section for the version", () => {
    assert.equal(checkRelease(BARE, "1.94.17").ok, false);
  });

  it("refuses when there is neither an Unreleased nor a version section", () => {
    assert.equal(checkRelease(EMPTY.replace("## [Unreleased]\n", ""), "1.3.0").ok, false);
  });

  it("refuses a version section alongside unreleased notes, which would drop them from the release", () => {
    const text = WITH_ENTRY.replace("## [1.2.0]", "## [1.3.0] — 2026-01-03\n\n- Hand-written.\n\n## [1.2.0]");
    const result = checkRelease(text, "1.3.0");
    assert.equal(result.ok, false);
    assert.match(result.message, /both a section for 1\.3\.0/);
  });

  it("refuses when Unreleased still holds everything the previous release shipped", () => {
    const next = WITH_ENTRY.replace("anything.\n", "anything.\n- Merged after 1.3.0.\n");
    const result = checkRelease(next, "1.4.0", { text: WITH_ENTRY, version: "v1.3.0" });
    assert.equal(result.ok, false);
    assert.match(result.message, /publish 1\.3\.0's notes again as 1\.4\.0/);
  });

  it("allows a release once the previous release's notes were moved out of Unreleased", () => {
    const synced = promoteReleased(WITH_ENTRY, WITH_ENTRY.replace("anything.\n", "anything.\n- Merged after 1.3.0.\n"), "1.3.0", "2026-02-01");
    assert.equal(checkRelease(synced, "1.4.0", { text: WITH_ENTRY, version: "1.3.0" }).ok, true);
  });

  it("ignores a previous release that shipped a hand-written section or had no notes", () => {
    assert.equal(checkRelease(WITH_ENTRY, "1.4.0", { text: EMPTY, version: "1.2.0" }).ok, true);
    assert.equal(checkRelease(WITH_ENTRY, "1.4.0", { text: EMPTY, version: "1.1.0" }).ok, true);
  });
});

describe("notes: the body a release publishes", () => {
  it("is the Unreleased body when there is no version section", () => {
    assert.equal(releaseNotes(WITH_ENTRY, "1.3.0"), "### Added\n\n- A new example command. It never changes anything.");
  });

  it("is the version section when it exists", () => {
    assert.equal(releaseNotes(EMPTY, "1.2.0"), "### Fixed\n\n- Sync no longer stops when a file is renamed while it uploads.");
  });

  it("throws rather than return blank notes", () => {
    assert.throws(() => releaseNotes(EMPTY, "1.3.0"), /blank release notes/);
  });
});

describe("promote: move shipped notes into the version section after release", () => {
  it("moves the released Unreleased entries into a dated version section", () => {
    const out = promoteReleased(WITH_ENTRY, WITH_ENTRY, "v1.3.0", "2026-02-01");
    assert.equal(checkRelease(out, "1.3.0").ok, true);
    assert.equal(releaseNotes(out, "1.3.0"), "### Added\n\n- A new example command. It never changes anything.");
    assert.match(out, /## \[Unreleased\]\n\n## \[1\.3\.0\] — 2026-02-01\n/);
    assert.equal(checkRelease(out, "1.4.0").ok, false, "Unreleased is empty again");
  });

  it("leaves entries merged after the tag under Unreleased", () => {
    const target = WITH_ENTRY.replace(
      "- A new example command. It never changes anything.\n",
      "- A new example command. It never changes anything.\n- A later change, merged after the tag.\n",
    ).replace("## [Unreleased]\n", "## [Unreleased]\n");
    const out = promoteReleased(WITH_ENTRY, target, "1.3.0", "2026-02-01");
    assert.equal(section(out, "1.3.0"), "### Added\n\n- A new example command. It never changes anything.");
    const unreleased = out.split("## [1.3.0]")[0];
    assert.match(unreleased, /A later change, merged after the tag/);
    assert.doesNotMatch(unreleased, /A new example command/);
  });

  it("is a no-op when the target already documents the version, or nothing shipped", () => {
    const once = promoteReleased(WITH_ENTRY, WITH_ENTRY, "1.3.0", "2026-02-01");
    assert.equal(promoteReleased(WITH_ENTRY, once, "1.3.0", "2026-02-01"), once);
    assert.equal(promoteReleased(EMPTY, EMPTY, "1.3.0", "2026-02-01"), EMPTY);
  });

  it("keeps a later entry whose text matches a shipped one", () => {
    const shippedText = EMPTY.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Fix sync.\n");
    const target = EMPTY.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Fix sync.\n- Fix sync.\n");
    const out = promoteReleased(shippedText, target, "1.3.0", "2026-02-01");
    assert.equal(section(out, "Unreleased"), "- Fix sync.");
    assert.equal(section(out, "1.3.0"), "- Fix sync.");
  });

  it("moves a shipped line that carries an inline comment", () => {
    const shippedText = EMPTY.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Fix sync. <!-- #12 -->\n");
    const target = EMPTY.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Fix sync. <!-- #12 -->\n- Later. <!-- #13 -->\n");
    const out = promoteReleased(shippedText, target, "1.3.0", "2026-02-01");
    assert.equal(section(out, "Unreleased"), "- Later. <!-- #13 -->");
    assert.equal(section(out, "1.3.0"), "- Fix sync. <!-- #12 -->");
  });

  it("leaves blank-line runs outside the moved notes byte-for-byte alone", () => {
    const history = "## [1.2.0] — 2026-01-02\n\n```\na\n\n\n\nb\n```\n";
    const shippedText = `# Changelog\n\n## [Unreleased]\n\n- Fix sync.\n\n${history}`;
    const out = promoteReleased(shippedText, shippedText, "1.3.0", "2026-02-01");
    assert.ok(out.endsWith(`- Fix sync.\n\n${history}`), out);
  });

  it("ignores a fenced heading when locating the Unreleased section", () => {
    const shippedText = "# Changelog\n\n## [Unreleased]\n\n- Headings now parse:\n\n```\n## 2.0.0\n```\n\n## [1.2.0]\n\n- Old.\n";
    const out = promoteReleased(shippedText, shippedText, "1.3.0", "2026-02-01");
    assert.equal(section(out, "Unreleased"), "");
    assert.equal(section(out, "1.3.0"), "- Headings now parse:\n\n```\n## 2.0.0\n```");
    assert.equal(section(out, "1.2.0"), "- Old.");
  });
});

describe("command line", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-changelog-"));
  const file = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const empty = file("empty.md", EMPTY);
  const entry = file("entry.md", WITH_ENTRY);
  const bare = file("bare.md", BARE);
  const run = (args) => {
    try {
      const output = execFileSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GITHUB_ACTIONS: "" },
      });
      return { code: 0, output };
    } catch (error) {
      return { code: error.status, output: `${error.stdout}${error.stderr}` };
    }
  };

  it("pr exits 1 on an empty Unreleased and 0 with an entry", () => {
    assert.equal(run(["pr", "--base", empty, "--head", empty]).code, 1);
    assert.equal(run(["pr", "--base", empty, "--head", entry]).code, 0);
  });

  it("pr-version exits 1 on a bump without notes and 0 without a bump", () => {
    assert.equal(run(["pr-version", "--base", bare, "--head", bare, "--base-version", "1.94.16", "--head-version", "1.94.17"]).code, 1);
    assert.equal(run(["pr-version", "--base", bare, "--head", bare, "--base-version", "1.94.16", "--head-version", "1.94.16"]).code, 0);
  });

  it("release exits 1 on empty notes and 0 with notes", () => {
    assert.equal(run(["release", "--file", empty, "--version", "v1.3.0"]).code, 1);
    assert.equal(run(["release", "--file", entry, "--version", "v1.3.0"]).code, 0);
  });

  it("notes prints the body, and exits 1 instead of printing blank notes", () => {
    const ok = run(["notes", "--file", entry, "--version", "v1.3.0"]);
    assert.equal(ok.code, 0);
    assert.match(ok.output, /A new example command/);
    assert.equal(run(["notes", "--file", empty, "--version", "v1.3.0"]).code, 1);
  });

  it("promote rewrites the target file in place", () => {
    const target = file("target.md", WITH_ENTRY);
    assert.equal(run(["promote", "--released", entry, "--target", target, "--version", "v1.3.0", "--date", "2026-02-01"]).code, 0);
    assert.match(readFileSync(target, "utf8"), /## \[1\.3\.0\] — 2026-02-01/);
  });

  it("release --previous exits 1 on a stale Unreleased, and 2 without --previous-version", () => {
    assert.equal(run(["release", "--file", entry, "--version", "v1.4.0", "--previous", entry, "--previous-version", "v1.3.0"]).code, 1);
    assert.equal(run(["release", "--file", entry, "--version", "v1.4.0", "--previous", entry]).code, 2);
  });

  it("exits 2 on bad usage", () => {
    assert.equal(run(["release", "--file"]).code, 2);
  });
});
