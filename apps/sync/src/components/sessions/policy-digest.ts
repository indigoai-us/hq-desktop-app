// Pure parser for the policy mentions HQ's hooks inject into a session.
//
// A line-for-line mirror of `crates/hq-desktop-core/src/agent_session/
// policy_digest.rs`. Both parse the SAME fixture
// (`./__fixtures__/hook-policy-reminder.txt`) in their tests, which is what
// keeps the two from drifting; change one, change the other.
//
// The text comes from `hookNotice` events. When a Claude session starts in the
// HQ root, `inject-policy-on-trigger.sh` prints a `<policy-reminder>` block:
//
//   > Policy `slug` (HARD — binding rule from `core/policies/slug.md`):
//   > (quoted full text of the rule…)
//   > Policy `other-slug` applies here: one-line rule summary
//
// and `hq-session.sh` prints a `<company-policy-digest co="indigo">` block on
// company bind whose entries look like
//
//   - [hard] **slug**: rule summary. Full text: `companies/co/policies/slug.md`.
//
// No I/O, no state, no regex: text in, digest out.

/** One policy a hook said applies to the session. */
export interface PolicyEntry {
  slug: string;
  /** The line named it HARD (binding) rather than advisory. */
  hard: boolean;
  /** One line of the rule, capped at `EXCERPT_CAP` characters. */
  excerpt: string;
}

/** Every policy mentioned so far, deduped by slug, plus the bound company. */
export interface PolicyDigest {
  /** The `co` of the LAST `<company-policy-digest>` seen — a later bind wins. */
  company: string | null;
  entries: PolicyEntry[];
}

/** Longest excerpt kept, in characters. */
export const EXCERPT_CAP = 160;

const POLICY_LINE_PREFIX = 'Policy `';
const DIGEST_OPEN = '<company-policy-digest co="';
const DIGEST_CLOSE = '</company-policy-digest>';
const DIGEST_HARD_PREFIX = '- [hard] **';

export function emptyPolicyDigest(): PolicyDigest {
  return { company: null, entries: [] };
}

/**
 * A block-quoted line with its `>` marker and one following space removed;
 * `null` when the line is not quoted at all.
 */
function unquote(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('>')) return null;
  const rest = trimmed.slice(1);
  return rest.startsWith(' ') ? rest.slice(1) : rest;
}

/** Cap an excerpt at `EXCERPT_CAP` characters (by code point, never mid-pair). */
function capExcerpt(text: string): string {
  const trimmed = text.trim();
  const chars = [...trimmed];
  if (chars.length <= EXCERPT_CAP) return trimmed;
  return `${chars.slice(0, EXCERPT_CAP - 1).join('').trimEnd()}…`;
}

/** Markdown emphasis and a trailing colon are decoration, not the rule. */
function cleanExcerpt(text: string): string {
  let stripped = text.replaceAll('**', '').trim();
  if (stripped.endsWith(':')) stripped = stripped.slice(0, -1);
  return capExcerpt(stripped);
}

/**
 * The excerpt for a `> Policy \`slug\` …` line.
 *
 * The one-line form carries its rule after `applies here:`. The full-text form
 * ends in a colon and quotes the rule's body on the lines that follow, so its
 * excerpt is the first prose line of that body — headings and blank quote
 * lines are skipped, and the next `Policy` line ends the search. With no body
 * at all, the parenthetical itself is kept so the entry is never blank.
 */
function excerptFor(rest: string, following: ReadonlyArray<string>): string {
  const applies = rest.indexOf('applies here:');
  if (applies !== -1) return cleanExcerpt(rest.slice(applies + 'applies here:'.length));
  for (const line of following) {
    const body = unquote(line);
    if (body === null) break;
    const text = body.trim();
    if (text.startsWith(POLICY_LINE_PREFIX)) break;
    if (text === '' || text.startsWith('#')) continue;
    return cleanExcerpt(text);
  }
  let bare = rest.trim();
  if (bare.endsWith(':')) bare = bare.slice(0, -1).trim();
  if (bare.startsWith('(') && bare.endsWith(')')) bare = bare.slice(1, -1);
  return cleanExcerpt(bare);
}

function pushEntry(digest: PolicyDigest, slug: string, hard: boolean, excerpt: string): void {
  const existing = digest.entries.find((entry) => entry.slug === slug);
  if (existing) {
    existing.hard = existing.hard || hard;
    if (existing.excerpt === '') existing.excerpt = excerpt;
    return;
  }
  digest.entries.push({ slug, hard, excerpt });
}

/**
 * Parse one hook's text into the policies it mentions.
 *
 * Entries are deduped by slug within the text (first mention keeps its
 * excerpt; `hard` is true if ANY mention said so).
 */
export function parsePolicyDigest(text: string): PolicyDigest {
  const lines = text.split('\n');
  const digest = emptyPolicyDigest();
  let inCompanyBlock = false;

  lines.forEach((raw, index) => {
    const line = raw.trim();

    const open = line.indexOf(DIGEST_OPEN);
    if (open !== -1) {
      const after = line.slice(open + DIGEST_OPEN.length);
      const end = after.indexOf('"');
      if (end !== -1) {
        const co = after.slice(0, end).trim();
        if (co) digest.company = co;
      }
      inCompanyBlock = true;
      return;
    }
    if (line.startsWith(DIGEST_CLOSE)) {
      inCompanyBlock = false;
      return;
    }

    if (inCompanyBlock) {
      if (line.startsWith(DIGEST_HARD_PREFIX)) {
        const after = line.slice(DIGEST_HARD_PREFIX.length);
        const close = after.indexOf('**');
        if (close !== -1) {
          const slug = after.slice(0, close).trim();
          let rest = after.slice(close + 2);
          while (rest.startsWith(':')) rest = rest.slice(1);
          rest = rest.trim();
          const fullText = rest.indexOf(' Full text:');
          const rule = fullText === -1 ? rest : rest.slice(0, fullText);
          pushEntry(digest, slug, true, cleanExcerpt(rule));
        }
      }
      return;
    }

    const body = unquote(raw);
    if (body === null) return;
    const trimmedBody = body.trimStart();
    if (!trimmedBody.startsWith(POLICY_LINE_PREFIX)) return;
    const after = trimmedBody.slice(POLICY_LINE_PREFIX.length);
    const tick = after.indexOf('`');
    if (tick === -1) return;
    const slug = after.slice(0, tick).trim();
    if (!slug) return;
    const rest = after.slice(tick + 1);
    const hard = rest.includes('HARD');
    pushEntry(digest, slug, hard, excerptFor(rest, lines.slice(index + 1)));
  });

  return digest;
}

/**
 * Fold a later hook's digest into an accumulated one — returns a NEW digest
 * (the fold is pure and its inputs are never mutated). Entries dedupe by slug
 * (first excerpt wins, `hard` is sticky); a later company bind replaces the
 * earlier one.
 */
export function mergePolicyDigest(into: PolicyDigest, from: PolicyDigest): PolicyDigest {
  const merged: PolicyDigest = {
    company: from.company ?? into.company,
    entries: into.entries.map((entry) => ({ ...entry })),
  };
  for (const entry of from.entries) pushEntry(merged, entry.slug, entry.hard, entry.excerpt);
  return merged;
}

/** "32 (4 hard)" — the chip's count, or "0" before anything has applied. */
export function policyCountLabel(digest: PolicyDigest): string {
  const hard = digest.entries.filter((entry) => entry.hard).length;
  return hard > 0 ? `${digest.entries.length} (${hard} hard)` : String(digest.entries.length);
}
