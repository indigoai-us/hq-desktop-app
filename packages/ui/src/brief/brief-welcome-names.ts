/**
 * The welcome text filters: what a welcome name, title or line may show.
 * Moved out of brief-welcome-edition.ts so the first view and the edition
 * share one copy.
 */

import { plainLine } from "./brief-runs.js";

const FILE = /\b[\w.-]+\.(?:svelte|tsx?|jsx?|mjs|cjs|vue|astro|json|mdx?|txt|csv|sql|lock|rs|py|java|php|cpp|css|scss|html|ya?ml|toml|sh|go|rb|swift|kt)\b/i;
/** Library names that read like a filename ("Node.js", "Next.js") and are not one. */
const LIBRARY = /\b(?:node|next|nuxt|vue|react|express|three|d3|chart|alpine|ember|angular|deno|nest|solid|p5)\.js\b/gi;
/** A path segment has a lowercase letter, so dates, "24/7", and "Q3/Q4" are not paths. */
const SEG = "[\\w.@-]*[a-z][\\w.@-]*";
const BARE_PATH = new RegExp(`^\\s*~?${SEG}(?:/${SEG})+/?\\s*$`);
const DEEP_PATH = new RegExp(`${SEG}/${SEG}/${SEG}`);
/** A one-slash path inside a sentence, named by a code folder ("Fix the bug in src/brief"). */
const CODE_DIR = /(?:^|[\s(])(?:src|apps?|packages|libs?|components|scripts|tests?|docs|crates|repos|companies|workspace)\/[\w.@-]+/;
/** Slashed words that are prose, not a path. */
const PROSE = new Set(["and/or", "either/or", "he/she", "his/her", "him/her", "s/he", "w/o", "n/a"]);

/** True when text shows a filename or a repo path ("WelcomeReport.svelte", "northstar/desktop"). */
export function looksLikePath(text: string, repo?: string | null): boolean {
  const t = text.trim();
  if (!t) return false;
  const named = t.replace(LIBRARY, "");
  if (FILE.test(named) || DEEP_PATH.test(t) || CODE_DIR.test(t)) return true;
  if (BARE_PATH.test(t) && !PROSE.has(t.toLowerCase())) return true;
  const r = repo?.trim();
  return !!r && r.includes("/") && t.toLowerCase().includes(r.toLowerCase());
}

/** Operator text that is never shown: stack traces, error codes, CLI commands, markup, links. */
const RAW = /traceback|exception|stack trace|\berror:|\bgh\s+(?:auth|api|pr)\b|\b[a-z]+_[a-z_]+\b|https?:\/\/|[{}<>`$\\]|^\s*[~/]/i;
/** Case matters here: "KeyError", "ENOENT", never "terror" or "Every". */
const RAW_CODE = /\b[A-Z]\w*Error\b|\bE(?:NOENT|ACCES|PERM|CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE|PIPE|NOTFOUND)\b/;

/**
 * Text from brief.json `welcome` when it reads as plain words; null for a path, a filename or raw operator text.
 * The brief's own plainLine check runs first, so the edition never shows a line the activity rows would hide.
 */
export function plainWelcomeText(text: string | null | undefined, max = 140): string | null {
  const t = plainLine(text?.replace(/\s+/g, " "), max);
  if (!t || looksLikePath(t) || RAW.test(t) || RAW_CODE.test(t)) return null;
  return t;
}

/** A stack trace or traceback line: Python's header and frames, a JS frame, or an exception's first line. */
const STACK = /\b[Tt]raceback \(most recent call last\)|^\s*File "[^"]*", line \d+|^\s*at \S.*\(\S*:\d+(?::\d+)?\)|^\s*[A-Z]\w*(?:Error|Exception): /;
/**
 * A path into the machine: /Users/, /home/ or /Volumes/ followed by a name, wherever it appears (so /var/home/,
 * /usr/home/ and ../Users/ count too; Users in any case), file://, or ~/ and ~user/ followed by a path.
 */
const HOME_PATH = /\/(?:[Uu][Ss][Ee][Rr][Ss]|home|Volumes)\/[^/\s]|(?:^|[^\w.-])(?:~[a-z_][\w.-]*\/|~\/\S)|\bfile:\/\//;
/**
 * A Windows home or user path: C:\Users\ or C:/Users/ on any drive, Documents and Settings followed by a slash,
 * a UNC \\server\share path, or WSL's /mnt/c/Users/.
 */
const WINDOWS_PATH =
  /(?:^|[^\w])[a-z]:[\\/]users[\\/]|documents and settings[\\/]|(?:^|[^\w\\])\\\\[^\s\\]+\\[^\s\\]|\/mnt\/[a-z]\/users\//i;
/**
 * High-confidence credential tokens, matched without regard to case:
 * - GitHub (ghp_, gho_, github_pat_), Slack xox?- tokens, AWS key ids (AKIA, ASIA), JWTs, and any sk-ant- or
 *   sk-proj- key.
 * - Bearer followed by a colon, quote or space and a long token. "Bearer of good news" is a name.
 * - token, secret, password or api key followed by ":" or "=" and a value of 16 or more characters. "Token budget
 *   review" is a name.
 * - A URL with user:pass@.
 */
const CREDENTIAL =
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|\bxox[a-z]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+|\bsk-(?:ant|proj)-|\bbearer[:\s"']+[\w.~+/=-]{20,}|\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*["']?[^\s"']{16,}|\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
/**
 * Credential shapes where case matters:
 * - Other sk- keys: 20 or more of [A-Za-z0-9_-] holding a digit and an upper-case letter. "sk-learn-notes" is a name.
 * - NAME_KEY=value, NAME_TOKEN=value, NAME_SECRET=value or NAME_PASSWORD=value, with the name in upper case.
 * - A bare 40-character AWS secret-key shape that mixes upper, lower, digits and "/" or "+".
 */
const CREDENTIAL_CASED =
  /\bsk-(?=[\w-]*\d)(?=[\w-]*[A-Z])[\w-]{20,}|\b[A-Z][A-Z0-9]*_(?:[A-Z0-9]+_)*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S|(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}\d)(?=[A-Za-z0-9/+]{0,39}[/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/;

/**
 * A welcome-edition name or title (a project, repo or integration name, a recent-work title, the headline, an
 * action label) as one line, or null. Unlike plainLine, which guards activity details and errors, it hides only
 * multi-line text, stack traces, home paths (Windows ones too) and credential tokens, so real titles such as
 * "EOD: ship X" or "HTTP 404 page redesign" show. Core already turns a title that may hold a credential into "Session in <project>".
 */
export function welcomeName(text: string | null | undefined, max = 140): string | null {
  if (!text?.trim() || /[\r\n\u2028\u2029\u0085]/.test(text)) return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length > max || STACK.test(t) || HOME_PATH.test(t) || WINDOWS_PATH.test(t)) return null;
  return CREDENTIAL.test(t) || CREDENTIAL_CASED.test(t) ? null : t;
}

/** "Good morning, Alex." by the brief's local hour; no name, no comma. */
export function welcomeGreeting(now: Date, userName?: string | null): string {
  const h = now.getHours();
  const part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  const name = userName?.trim();
  return name ? `Good ${part}, ${name}.` : `Good ${part}.`;
}
