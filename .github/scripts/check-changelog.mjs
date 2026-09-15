#!/usr/bin/env node
/* global process, console */
// Release-notes guard for CHANGELOG.md. Release notes are the only record users
// get of a release and are permanent once published, so this refuses to let a
// change or a release through without them.
//
//   check-changelog.mjs pr --base <file> --head <file>
//     A pull request must add at least one line of notes under
//     `## [Unreleased]`, or add a new, non-empty release section.
//
//   check-changelog.mjs pr-version --base <file> --head <file>
//                                  --base-version <x> --head-version <y>
//     For repos where the version-bump PR is the release: a PR that changes the
//     published version must add non-empty notes for the new version. A PR that
//     does not change the version publishes nothing and passes.
//
//   check-changelog.mjs release --file <file> --version <x.y.z>
//     A release must not publish blank notes. If `## [<version>]` exists its
//     body is what ships; otherwise `## [Unreleased]` is what gets promoted.
//
//   check-changelog.mjs notes --file <file> --version <x.y.z>
//     Print the notes that release would publish (after the same check).
//
//   check-changelog.mjs promote --released <file> --target <file> --version <x.y.z>
//     After a release, move the notes it shipped into `## [<version>]` in the
//     target file (the branch being synced). Only the lines the released file
//     had under Unreleased move; entries merged since the tag stay put.
//
// Headings may be `## [1.2.3]`, `## [1.2.3] — date`, `## 1.2.3` or
// `## [Unreleased]`. Exit codes: 0 pass, 1 guard failed, 2 usage error.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const UNRELEASED = "Unreleased";

const HEADING = /^## (?:\[([^\]]+)\]|v?(\d[^\s]*))/;

/**
 * Split a changelog into its `## ...` sections.
 * @param {string} text
 * @returns {Map<string, string[]>} section key (e.g. "Unreleased", "5.111.0") -> body lines
 */
export function parseSections(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = normalizeVersion(heading[1] ?? heading[2]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (/^##? /.test(line)) {
      // Any other level-1/level-2 heading ends the current section.
      current = null;
      continue;
    }
    if (current !== null) sections.get(current).push(line);
  }
  return sections;
}

/** @param {string} version */
export function normalizeVersion(version) {
  const trimmed = String(version).trim();
  return /^unreleased$/i.test(trimmed) ? UNRELEASED : trimmed.replace(/^v(?=\d)/, "");
}

/**
 * Lines a reader would actually see as notes: not blank, not a bare
 * `### Added`-style subheading, not inside an HTML comment. Comments are
 * removed from the whole section first, so a placeholder spanning several
 * lines (or one never closed, which Markdown hides to the end) is not notes.
 * @param {string[] | undefined} lines
 * @returns {string[]}
 */
export function contentLines(lines) {
  return (lines ?? [])
    .join("\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => !/^#{1,6}(\s|$)/.test(line));
}

/**
 * @param {string} baseText CHANGELOG.md on the PR's base
 * @param {string} headText CHANGELOG.md as the PR would merge it
 * @returns {{ ok: boolean, message: string }}
 */
export function checkPullRequest(baseText, headText) {
  const base = parseSections(baseText);
  const head = parseSections(headText);

  if (!head.has(UNRELEASED)) {
    return {
      ok: false,
      message:
        "CHANGELOG.md has no `## [Unreleased]` heading. Releases promote that section into the release notes, so it must stay. Restore the heading.",
    };
  }

  const before = new Set(contentLines(base.get(UNRELEASED)));
  const added = contentLines(head.get(UNRELEASED)).filter((line) => !before.has(line));
  if (added.length > 0) {
    return {
      ok: true,
      message: `CHANGELOG.md: this PR adds ${added.length} line(s) of notes under ## [Unreleased].`,
    };
  }

  for (const [key, lines] of head) {
    if (key === UNRELEASED || base.has(key)) continue;
    if (contentLines(lines).length > 0) {
      return { ok: true, message: `CHANGELOG.md: this PR adds release notes for ## [${key}].` };
    }
  }

  return {
    ok: false,
    message:
      "This PR adds no release notes. Add an entry under `## [Unreleased]` in CHANGELOG.md describing what changes for users, in plain language. If this change genuinely has no user impact (CI, tests, internal refactors), add the `no-changelog` label to the PR instead.",
  };
}

/**
 * @param {string} baseText
 * @param {string} headText
 * @param {string} baseVersion version on the PR's base
 * @param {string} headVersion version as the PR would merge it
 * @returns {{ ok: boolean, message: string }}
 */
export function checkVersionPullRequest(baseText, headText, baseVersion, headVersion) {
  const from = normalizeVersion(baseVersion);
  const to = normalizeVersion(headVersion);
  if (from === to) {
    return {
      ok: true,
      message: `This PR does not change the package version (${to}), so it publishes nothing and needs no release notes. The PR that bumps the version must write notes covering it.`,
    };
  }

  const lines = contentLines(parseSections(headText).get(to));
  if (lines.length === 0) {
    return {
      ok: false,
      message: `This PR changes the version from ${from} to ${to}, which publishes ${to} when it merges, but CHANGELOG.md has no notes for it. Add a non-empty \`## ${to}\` section describing what ${to} changes.`,
    };
  }
  const before = new Set(contentLines(parseSections(baseText).get(to)));
  const added = lines.filter((line) => !before.has(line)).length;
  return {
    ok: true,
    message: `CHANGELOG.md has ${lines.length} line(s) of notes for ${to}${added < lines.length ? ` (${added} added by this PR)` : ""}.`,
  };
}

/**
 * @param {string} text CHANGELOG.md at the release commit
 * @param {string} version the version being released, without a leading `v`
 * @returns {{ ok: boolean, message: string, section?: string }}
 */
export function checkRelease(text, version) {
  const sections = parseSections(text);
  const key = normalizeVersion(version);

  if (sections.has(key)) {
    const lines = contentLines(sections.get(key));
    return lines.length > 0
      ? { ok: true, section: key, message: `CHANGELOG.md has notes for ${key} (${lines.length} line(s)).` }
      : {
          ok: false,
          message: `CHANGELOG.md has a section for ${key}, but it is empty, so ${key} would be published with blank release notes. Write the notes for ${key}, then release again.`,
        };
  }

  if (!sections.has(UNRELEASED)) {
    return {
      ok: false,
      message: `CHANGELOG.md has no notes for ${key}: there is neither a ## [${key}] section nor a ## [Unreleased] section. Write the notes by hand, then release again.`,
    };
  }

  const lines = contentLines(sections.get(UNRELEASED));
  return lines.length > 0
    ? { ok: true, section: UNRELEASED, message: `CHANGELOG.md: ## [Unreleased] has ${lines.length} line(s) of notes to release as ${key}.` }
    : {
        ok: false,
        message: `Refusing to release ${key}: ## [Unreleased] in CHANGELOG.md is empty, so it would be published with blank release notes. Land a PR that writes the notes for what changed since the last release, then release that commit.`,
      };
}

/**
 * The notes body `checkRelease` approved, trimmed of surrounding blank lines.
 * @param {string} text
 * @param {string} version
 * @returns {string}
 */
export function releaseNotes(text, version) {
  const result = checkRelease(text, version);
  if (!result.ok) throw new Error(result.message);
  const lines = parseSections(text).get(result.section) ?? [];
  return lines.join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/**
 * Move the notes a release shipped from `## [Unreleased]` into a new
 * `## [<version>] — <date>` section of the target changelog. Idempotent: a
 * target that already documents the version is returned unchanged.
 * @param {string} releasedText CHANGELOG.md at the release tag
 * @param {string} targetText CHANGELOG.md on the branch being synced
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 * @returns {string}
 */
export function promoteReleased(releasedText, targetText, version, date) {
  const key = normalizeVersion(version);
  const target = parseSections(targetText);
  if (target.has(key)) return targetText;
  const released = parseSections(releasedText);
  if (released.has(key)) return targetText;

  const shipped = released.get(UNRELEASED) ?? [];
  const shippedContent = new Set(contentLines(shipped));
  if (shippedContent.size === 0) return targetText;

  const lines = targetText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## \[Unreleased\]/i.test(line));
  if (start === -1) return targetText;
  let end = lines.findIndex((line, index) => index > start && /^##? /.test(line));
  if (end === -1) end = lines.length;

  // Keep entries merged after the tag; drop the ones that shipped. Subheadings
  // with nothing left beneath them go too.
  const remaining = lines
    .slice(start + 1, end)
    .filter((line) => !shippedContent.has(line.trim()));
  const kept = [];
  for (let i = 0; i < remaining.length; i += 1) {
    const line = remaining[i];
    if (/^#{3,6}\s/.test(line.trim())) {
      let j = i + 1;
      while (j < remaining.length && remaining[j].trim() === "") j += 1;
      if (j >= remaining.length || /^#{3,6}\s/.test(remaining[j].trim())) continue;
    }
    kept.push(line);
  }
  const unreleasedBody = contentLines(kept).length > 0 ? ["", ...trimBlank(kept), ""] : [""];
  const releasedBody = trimBlank(shipped);

  const next = [
    ...lines.slice(0, start + 1),
    ...unreleasedBody,
    `## [${key}] — ${date}`,
    "",
    ...releasedBody,
    "",
    ...lines.slice(end),
  ];
  return next.join("\n").replace(/\n{3,}/g, "\n\n");
}

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a += 1;
  while (b > a && lines[b - 1].trim() === "") b -= 1;
  return lines.slice(a, b);
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith("--") || value === undefined) return { mode, flags, bad: true };
    flags[key.slice(2)] = value;
  }
  return { mode, flags, bad: false };
}

const USAGE = `usage: check-changelog.mjs pr --base <file> --head <file>
       check-changelog.mjs pr-version --base <file> --head <file> --base-version <x> --head-version <y>
       check-changelog.mjs release --file <file> --version <x.y.z>
       check-changelog.mjs notes --file <file> --version <x.y.z>
       check-changelog.mjs promote --released <file> --target <file> --version <x.y.z>`;

export function main(argv, io = { log: console.log, error: console.error, env: process.env }) {
  const { mode, flags, bad } = parseArgs(argv);
  const read = (path) => readFileSync(path, "utf8");
  let result;
  try {
    if (bad) {
      result = null;
    } else if (mode === "pr" && flags.base && flags.head) {
      result = checkPullRequest(read(flags.base), read(flags.head));
    } else if (mode === "pr-version" && flags.base && flags.head && flags["base-version"] && flags["head-version"]) {
      result = checkVersionPullRequest(read(flags.base), read(flags.head), flags["base-version"], flags["head-version"]);
    } else if (mode === "release" && flags.file && flags.version) {
      result = checkRelease(read(flags.file), flags.version);
    } else if (mode === "notes" && flags.file && flags.version) {
      const checked = checkRelease(read(flags.file), flags.version);
      if (checked.ok) {
        io.log(releaseNotes(read(flags.file), flags.version));
        return 0;
      }
      result = checked;
    } else if (mode === "promote" && flags.released && flags.target && flags.version) {
      const date = flags.date ?? new Date().toISOString().slice(0, 10);
      const before = read(flags.target);
      const after = promoteReleased(read(flags.released), before, flags.version, date);
      if (after !== before) writeFileSync(flags.target, after);
      io.log(after === before ? `${flags.target}: nothing to promote for ${flags.version}.` : `${flags.target}: promoted the released notes into ${normalizeVersion(flags.version)}.`);
      return 0;
    }
  } catch (error) {
    io.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  if (!result) {
    io.error(USAGE);
    return 2;
  }
  if (result.ok) {
    io.log(result.message);
    return 0;
  }
  const prefix = io.env.GITHUB_ACTIONS === "true" ? "::error title=Release notes::" : "error: ";
  io.error(`${prefix}${result.message}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
