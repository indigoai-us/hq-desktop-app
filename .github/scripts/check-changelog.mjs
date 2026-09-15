#!/usr/bin/env node
/* global process, console */
// Release-notes guard for CHANGELOG.md. Release notes are the only record users
// get of a release and are permanent once published, so this refuses to let a
// change or a release through without them.
//
//   check-changelog.mjs pr --base <file> --head <file>
//     A pull request must add at least one line of notes under
//     `## [Unreleased]` (or add a new, non-empty release section), and must not
//     remove or rewrite notes other changes already wrote there.
//
//   check-changelog.mjs pr-version --base <file> --head <file>
//                                  --base-version <x> --head-version <y>
//     For repos where the version-bump PR is the release: a PR that changes the
//     published version must add non-empty notes for the new version. A PR that
//     does not change the version publishes nothing and passes.
//
//   check-changelog.mjs release --file <file> --version <x.y.z>
//                               [--previous <file> --previous-version <v>]
//     A release must not publish blank notes. If `## [<version>]` exists its
//     body is what ships (and Unreleased must then be empty); otherwise
//     `## [Unreleased]` is what gets released. With --previous (CHANGELOG.md at
//     the previous release), a release is refused when Unreleased still holds
//     everything the previous release shipped, because publishing would repeat
//     those notes.
//
//   check-changelog.mjs notes --file <file> --version <x.y.z> [--previous ...]
//     Print the notes that release would publish (after the same check).
//
//   check-changelog.mjs promote --released <file> --target <file> --version <x.y.z>
//     After a release, move the notes it shipped into `## [<version>]` in the
//     target file (the branch being synced). Only the lines the released file
//     had under Unreleased move, once each; entries merged since the tag stay.
//
// Headings may be `## [1.2.3]`, `## [1.2.3] — date`, `## 1.2.3` or
// `## [Unreleased]`, and are ignored inside fenced code blocks.
// Exit codes: 0 pass, 1 guard failed, 2 usage error.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const UNRELEASED = "Unreleased";

const HEADING = /^## (?:\[([^\]]+)\]|v?(\d[^\s]*))/;
const FENCE = /^ {0,3}(```|~~~)/;
const MARKDOWN_HEADING = /^#{1,6}(\s|$)/;

/** @param {string} version */
export function normalizeVersion(version) {
  const trimmed = String(version).trim();
  return /^unreleased$/i.test(trimmed) ? UNRELEASED : trimmed.replace(/^v(?=\d)/, "");
}

/**
 * Walk the lines of a changelog, reporting which are real (not fenced) `## `
 * section boundaries.
 * @param {string[]} lines
 * @returns {Array<{ line: string, key: string | null, boundary: boolean }>}
 */
function scan(lines) {
  let fence = null;
  return lines.map((line) => {
    const marker = FENCE.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1];
      else if (marker[1] === fence) fence = null;
      return { line, key: null, boundary: false };
    }
    if (fence !== null) return { line, key: null, boundary: false };
    const heading = HEADING.exec(line);
    if (heading) return { line, key: normalizeVersion(heading[1] ?? heading[2]), boundary: true };
    return { line, key: null, boundary: /^##? /.test(line) };
  });
}

/**
 * Split a changelog into its `## ...` sections.
 * @param {string} text
 * @returns {Map<string, string[]>} section key (e.g. "Unreleased", "5.111.0") -> body lines
 */
export function parseSections(text) {
  const sections = new Map();
  let current = null;
  for (const { line, key, boundary } of scan(text.split(/\r?\n/))) {
    if (boundary) {
      // A version/Unreleased heading opens a section; any other level-1/level-2
      // heading ends the current one.
      current = key;
      if (current !== null && !sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current).push(line);
  }
  return sections;
}

/**
 * Lines a reader would actually see as notes: not blank, not a bare
 * `### Added`-style subheading, not a code-fence marker, not inside an HTML
 * comment. Comments are removed from the whole section first, so a placeholder
 * spanning several lines (or one never closed, which Markdown hides to the
 * end) is not notes.
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
    .filter((line) => !MARKDOWN_HEADING.test(line) && !FENCE.test(line));
}

function counts(lines) {
  const map = new Map();
  for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
  return map;
}

/** Lines of `lines` left over after removing each line of `remove` once. */
function subtract(lines, remove) {
  const left = counts(remove);
  return lines.filter((line) => {
    const n = left.get(line) ?? 0;
    if (n === 0) return true;
    left.set(line, n - 1);
    return false;
  });
}

const quote = (line) => `"${line.length > 80 ? `${line.slice(0, 77)}...` : line}"`;

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
        "CHANGELOG.md has no `## [Unreleased]` heading. Releases publish that section as the release notes, so it must stay. Restore the heading.",
    };
  }

  const before = contentLines(base.get(UNRELEASED));
  const after = contentLines(head.get(UNRELEASED));
  const newSections = [...head]
    .filter(([key]) => key !== UNRELEASED && !base.has(key))
    .flatMap(([, lines]) => contentLines(lines));

  // Notes other changes wrote must survive, either where they were or moved
  // into a new release section. Rewording one counts as removing it, so an
  // edit can never stand in for this PR's own entry, and a conflict resolution
  // that drops someone else's note is caught.
  const removed = subtract(before, [...after, ...newSections]);
  if (removed.length > 0) {
    return {
      ok: false,
      message: `This PR removes or rewrites ${removed.length} existing note(s) under \`## [Unreleased]\` in CHANGELOG.md, starting with ${quote(removed[0])}. Those notes belong to changes that have not been released yet, so keep them exactly as they are and add your own entry alongside them. If the edit is deliberate (a correction, or a note for a change that was reverted), add the \`no-changelog\` label so the edit is visible in review.`,
    };
  }

  const added = subtract(after, before);
  if (added.length > 0) {
    return {
      ok: true,
      message: `CHANGELOG.md: this PR adds ${added.length} line(s) of notes under ## [Unreleased].`,
    };
  }
  if (newSections.length > 0) {
    return { ok: true, message: "CHANGELOG.md: this PR adds a new, non-empty release section." };
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
  return { ok: true, message: `CHANGELOG.md has ${lines.length} line(s) of notes for ${to}.` };
}

/**
 * @param {string} text CHANGELOG.md at the release commit
 * @param {string} version the version being released
 * @param {{ text: string, version: string }} [previous] CHANGELOG.md at the previous release
 * @returns {{ ok: boolean, message: string, section?: string }}
 */
export function checkRelease(text, version, previous) {
  const sections = parseSections(text);
  const key = normalizeVersion(version);
  const unreleased = contentLines(sections.get(UNRELEASED));

  if (sections.has(key)) {
    const lines = contentLines(sections.get(key));
    if (lines.length === 0) {
      return {
        ok: false,
        message: `CHANGELOG.md has a section for ${key}, but it is empty, so ${key} would be published with blank release notes. Write the notes for ${key}, then release again.`,
      };
    }
    if (unreleased.length > 0) {
      return {
        ok: false,
        message: `CHANGELOG.md has both a section for ${key} and ${unreleased.length} line(s) of notes under ## [Unreleased]. Only the ${key} section would be published, so the Unreleased notes would be left out of ${key} and shipped later under the wrong version. Move them into the ${key} section (or remove the hand-written section), then release again.`,
      };
    }
    return { ok: true, section: key, message: `CHANGELOG.md has notes for ${key} (${lines.length} line(s)).` };
  }

  if (!sections.has(UNRELEASED)) {
    return {
      ok: false,
      message: `CHANGELOG.md has no notes for ${key}: there is neither a ## [${key}] section nor a ## [Unreleased] section. Write the notes by hand, then release again.`,
    };
  }
  if (unreleased.length === 0) {
    return {
      ok: false,
      message: `Refusing to release ${key}: ## [Unreleased] in CHANGELOG.md is empty, so it would be published with blank release notes. Land a PR that writes the notes for what changed since the last release, then release that commit.`,
    };
  }

  if (previous?.text) {
    const prevKey = normalizeVersion(previous.version);
    const prevSections = parseSections(previous.text);
    const shipped = prevSections.has(prevKey) ? [] : contentLines(prevSections.get(UNRELEASED));
    if (shipped.length > 0 && subtract(shipped, unreleased).length === 0) {
      return {
        ok: false,
        message: `Refusing to release ${key}: ## [Unreleased] still holds every note ${prevKey} already published, so they were never moved into a ## [${prevKey}] section (the version sync to main after ${prevKey} did not land). Releasing now would publish ${prevKey}'s notes again as ${key}. Move those entries into ## [${prevKey}] on main, then tag again.`,
      };
    }
  }

  return {
    ok: true,
    section: UNRELEASED,
    message: `CHANGELOG.md: ## [Unreleased] has ${unreleased.length} line(s) of notes to release as ${key}.`,
  };
}

/**
 * The notes body `checkRelease` approved, trimmed of surrounding blank lines.
 * @param {string} text
 * @param {string} version
 * @param {{ text: string, version: string }} [previous]
 * @returns {string}
 */
export function releaseNotes(text, version, previous) {
  const result = checkRelease(text, version, previous);
  if (!result.ok) throw new Error(result.message);
  return trimBlank(parseSections(text).get(result.section) ?? []).join("\n");
}

/** Visible text of one line, for matching a shipped line against the target. */
const visible = (line) => line.replace(/<!--.*?-->/g, "").trim();

/**
 * Move the notes a release shipped from `## [Unreleased]` into a new
 * `## [<version>] — <date>` section of the target changelog. Each shipped line
 * is taken out of the target once, so a later entry with the same text stays.
 * Everything outside the Unreleased section is left byte-for-byte alone.
 * Idempotent: a target that already documents the version is returned as-is.
 * @param {string} releasedText CHANGELOG.md at the release tag
 * @param {string} targetText CHANGELOG.md on the branch being synced
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 * @returns {string}
 */
export function promoteReleased(releasedText, targetText, version, date) {
  const key = normalizeVersion(version);
  if (parseSections(targetText).has(key)) return targetText;
  const released = parseSections(releasedText);
  if (released.has(key)) return targetText;

  const shipped = released.get(UNRELEASED) ?? [];
  if (contentLines(shipped).length === 0) return targetText;

  const lines = targetText.split("\n");
  const scanned = scan(lines);
  const start = scanned.findIndex((entry) => entry.key === UNRELEASED);
  if (start === -1) return targetText;
  let end = scanned.findIndex((entry, index) => index > start && entry.boundary);
  if (end === -1) end = lines.length;

  const remaining = counts(
    shipped.map(visible).filter((line) => line !== "" && !MARKDOWN_HEADING.test(line)),
  );
  const survivors = lines.slice(start + 1, end).filter((line) => {
    const text = visible(line);
    const n = remaining.get(text) ?? 0;
    if (text === "" || MARKDOWN_HEADING.test(text) || n === 0) return true;
    remaining.set(text, n - 1);
    return false;
  });

  // Subheadings left with nothing beneath them go too.
  const kept = survivors.filter((line, index) => {
    if (!/^#{3,6}\s/.test(line.trim())) return true;
    const next = survivors.slice(index + 1).find((candidate) => candidate.trim() !== "");
    return next !== undefined && !/^#{3,6}\s/.test(next.trim());
  });

  const unreleasedBody = contentLines(kept).length > 0 ? ["", ...trimBlank(kept), ""] : [""];
  const tail = lines.slice(end);
  const next = [
    ...lines.slice(0, start + 1),
    ...unreleasedBody,
    `## [${key}] — ${date}`,
    "",
    ...trimBlank(shipped),
    ...(tail.length > 0 && !(tail.length === 1 && tail[0] === "") ? [""] : []),
    ...tail,
  ];
  let out = next.join("\n");
  if (targetText.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  return out;
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
       check-changelog.mjs release --file <file> --version <x.y.z> [--previous <file> --previous-version <v>]
       check-changelog.mjs notes --file <file> --version <x.y.z> [--previous <file> --previous-version <v>]
       check-changelog.mjs promote --released <file> --target <file> --version <x.y.z> [--date YYYY-MM-DD]`;

export function main(argv, io = { log: console.log, error: console.error, env: process.env }) {
  const { mode, flags, bad } = parseArgs(argv);
  const read = (path) => readFileSync(path, "utf8");
  if (!bad && Boolean(flags.previous) !== Boolean(flags["previous-version"])) {
    io.error("error: --previous and --previous-version go together.");
    return 2;
  }
  const previous = () => (flags.previous ? { text: read(flags.previous), version: flags["previous-version"] } : undefined);
  let result;
  try {
    if (bad) {
      result = null;
    } else if (mode === "pr" && flags.base && flags.head) {
      result = checkPullRequest(read(flags.base), read(flags.head));
    } else if (mode === "pr-version" && flags.base && flags.head && flags["base-version"] && flags["head-version"]) {
      result = checkVersionPullRequest(read(flags.base), read(flags.head), flags["base-version"], flags["head-version"]);
    } else if (mode === "release" && flags.file && flags.version) {
      result = checkRelease(read(flags.file), flags.version, previous());
    } else if (mode === "notes" && flags.file && flags.version) {
      const checked = checkRelease(read(flags.file), flags.version, previous());
      if (checked.ok) {
        io.log(releaseNotes(read(flags.file), flags.version, previous()));
        return 0;
      }
      result = checked;
    } else if (mode === "promote" && flags.released && flags.target && flags.version) {
      const date = flags.date ?? new Date().toISOString().slice(0, 10);
      const before = read(flags.target);
      const after = promoteReleased(read(flags.released), before, flags.version, date);
      if (after !== before) writeFileSync(flags.target, after);
      io.log(
        after === before
          ? `${flags.target}: nothing to promote for ${flags.version}.`
          : `${flags.target}: promoted the released notes into ${normalizeVersion(flags.version)}.`,
      );
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
