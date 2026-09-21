/**
 * `hq://` → native route-string adapter (US-004).
 *
 * Maps console / email / Slack links onto the grammar in `route.ts`. Anything
 * else is rejected. The raw URL is never logged — only length and segment
 * count (shape), because a custom-scheme URL is attacker-controlled input.
 */

import {
  parseDesktopRoute,
  serializeDesktopRoute,
} from './route';

const LOG_PREFIX = '[deep-link]';

function isAllowedUrlByte(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true; // 0-9
  if (code >= 0x41 && code <= 0x5a) return true; // A-Z
  if (code >= 0x61 && code <= 0x7a) return true; // a-z
  return (
    code === 0x2d || // -
    code === 0x2e || // .
    code === 0x5f || // _
    code === 0x7e || // ~
    code === 0x3a || // :
    code === 0x2f || // /
    code === 0x3f || // ?
    code === 0x23 || // #
    code === 0x5b || // [
    code === 0x5d || // ]
    code === 0x40 || // @
    code === 0x21 || // !
    code === 0x24 || // $
    code === 0x26 || // &
    code === 0x28 || // (
    code === 0x29 || // )
    code === 0x2a || // *
    code === 0x2b || // +
    code === 0x2c || // ,
    code === 0x3b || // ;
    code === 0x3d || // =
    code === 0x25 // %
  );
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

/** Byte-for-byte allowlist matching `validate_hqwork_deep_link`. */
export function validateHqUrlBytes(raw: string): boolean {
  const units: number[] = [];
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code === undefined) return false;
    units.push(code);
  }
  let i = 0;
  while (i < units.length) {
    const code = units[i]!;
    if (code < 0x21 || code > 0x7e) return false;
    if (
      code === 0x22 || // "
      code === 0x27 || // '
      code === 0x60 || // `
      code === 0x3c || // <
      code === 0x3e || // >
      code === 0x5c || // \
      code === 0x7c // |
    ) {
      return false;
    }
    if (code === 0x25) {
      if (
        i + 2 >= units.length ||
        !isHexDigit(units[i + 1]!) ||
        !isHexDigit(units[i + 2]!)
      ) {
        return false;
      }
      i += 3;
      continue;
    }
    if (!isAllowedUrlByte(code)) return false;
    i += 1;
  }
  return true;
}

function isIdToken(value: string): boolean {
  if (!value) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) return false;
    const ok =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x5f ||
      code === 0x2d;
    if (!ok) return false;
  }
  return true;
}

function isSlugToken(value: string): boolean {
  if (!value) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) return false;
    const ok =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x5f ||
      code === 0x2d;
    if (!ok) return false;
  }
  return true;
}

function isPathToken(value: string): boolean {
  if (!value || value === '.' || value === '..') return false;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) return false;
    const ok =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x5f ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x7e;
    if (!ok) return false;
  }
  return true;
}

function warnIgnored(raw: string, segs: number): void {
  console.warn(`${LOG_PREFIX} HQ_URL_IGNORE len=${raw.length} segs=${segs}`);
}

function segmentsFromUrl(url: URL): string[] {
  const segs: string[] = [];
  const host = url.hostname.trim();
  if (host) segs.push(host);
  for (const part of url.pathname.split('/')) {
    const trimmed = part.trim();
    if (trimmed) segs.push(trimmed);
  }
  return segs;
}

function mapSegments(segs: readonly string[]): string | null {
  if (segs.length === 1 && segs[0]!.toLowerCase() === 'meetings') {
    return 'meetings';
  }
  const head = segs[0]?.toLowerCase() ?? '';
  if (head === 'inbox') {
    if (segs.length === 3 && segs[1] === 'dm' && isIdToken(segs[2]!)) {
      return `inbox:dm:${segs[2]}`;
    }
    if (segs.length === 3 && segs[1] === 'channel' && isIdToken(segs[2]!)) {
      return `inbox:channel:${segs[2]}`;
    }
    if (
      segs.length === 4 &&
      segs[1] === 'channel' &&
      isIdToken(segs[2]!) &&
      isIdToken(segs[3]!)
    ) {
      return `inbox:channel:${segs[2]}:${segs[3]}`;
    }
    return null;
  }
  if (head === 'files') {
    const slug = segs[1] ?? '';
    const rest = segs.slice(2);
    if (!isSlugToken(slug) || rest.length === 0 || !rest.every(isPathToken)) {
      return null;
    }
    return `files:${slug}:${rest.join(':')}`;
  }
  if (head === 'company') {
    const slug = segs[1] ?? '';
    if (!isSlugToken(slug)) return null;
    if (segs.length === 2) return `company:${slug}`;
    if (segs.length === 3 && isIdToken(segs[2]!)) {
      return `company:${slug}:${segs[2]}`;
    }
    return null;
  }
  return null;
}

/**
 * Map an `hq://` URL onto a `route.ts` wire string.
 * Returns `null` (and logs a shape-only warning) for anything else.
 */
export function parseHqUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed || !validateHqUrlBytes(trimmed)) {
    warnIgnored(trimmed, 0);
    return null;
  }
  for (const part of trimmed.split('/')) {
    if (part === '.' || part === '..' || part.startsWith('..')) {
      warnIgnored(trimmed, 0);
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    warnIgnored(trimmed, 0);
    return null;
  }
  if (url.protocol.toLowerCase() !== 'hq:') {
    warnIgnored(trimmed, 0);
    return null;
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    warnIgnored(trimmed, 0);
    return null;
  }
  const segs = segmentsFromUrl(url);
  const mapped = mapSegments(segs);
  if (!mapped) {
    warnIgnored(trimmed, segs.length);
    return null;
  }
  const parsed = parseDesktopRoute(mapped);
  if (!parsed || parsed.kind === 'unsupported') {
    warnIgnored(trimmed, segs.length);
    return null;
  }
  return serializeDesktopRoute(parsed);
}
