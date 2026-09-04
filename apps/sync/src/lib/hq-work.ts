/**
 * HQ Work install detection + launcher + handoff flag.
 *
 * Thin invoke wrappers. Detection is state, not a setup trigger: callers
 * must not treat `hq_work_installed` as a reason to open onboarding.
 *
 * Invoker is injectable so unit tests never hit Tauri.
 */

import { invoke } from '@tauri-apps/api/core';

export const HQ_WORK_BUNDLE_ID = 'ai.getindigo.hq-work';

export type HqWorkInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export function hqWorkHandoffEnabled(
  _flag?: boolean | null | undefined,
): boolean {
  return true;
}

export async function detectHqWorkInstalled(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
): Promise<boolean> {
  return invokeFn<boolean>('hq_work_installed');
}

export async function launchHqWork(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
  url?: string | null,
): Promise<void> {
  await invokeFn<void>('launch_hq_work', { url: url ?? null });
}

export async function getHqWorkHandoff(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
): Promise<boolean> {
  return invokeFn<boolean>('get_hq_work_handoff');
}

export async function setHqWorkHandoff(
  invokeFn: HqWorkInvoker,
  enabled: boolean,
): Promise<void> {
  await invokeFn<void>('set_hq_work_handoff', { enabled });
}

export async function installHqWork(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
): Promise<void> {
  await invokeFn<void>('install_hq_work');
}

export async function getHqWorkHandoffCardShown(
  invokeFn: HqWorkInvoker = invoke as HqWorkInvoker,
): Promise<boolean> {
  return invokeFn<boolean>('get_hq_work_handoff_card_shown');
}

/** Same charset as Rust `hqwork_query_token`: ASCII alnum + `-` `_` `.` `~`. */
const HQWORK_QUERY_TOKEN = /^[A-Za-z0-9._~-]+$/;

export type HqWorkOpenTarget = {
  channelId: string | null;
  personUid: string | null;
  replyRootEventId: string | null;
};

export function hqworkQueryToken(
  raw: string | null | undefined,
): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;
  return HQWORK_QUERY_TOKEN.test(trimmed) ? trimmed : null;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isAllowedHqWorkUrlByte(code: number): boolean {
  if (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  ) {
    return true;
  }
  return '-._~:/?#[]@!$&()*+,;='.includes(String.fromCharCode(code));
}

/**
 * Byte-for-byte mirror of Rust `validate_hqwork_deep_link`.
 * Does not percent-decode — HQ Work treats `%XX` as literal query bytes.
 */
export function isValidHqWorkDeepLink(url: string): boolean {
  if (!url.startsWith('hqwork://open?')) return false;
  for (let i = 0; i < url.length; ) {
    const code = url.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
    switch (code) {
      case 0x22: // "
      case 0x27: // '
      case 0x60: // `
      case 0x3c: // <
      case 0x3e: // >
      case 0x5c: // \
      case 0x7c: // |
        return false;
      case 0x25: {
        if (i + 2 >= url.length) return false;
        if (!isHexDigit(url.charCodeAt(i + 1)) || !isHexDigit(url.charCodeAt(i + 2))) {
          return false;
        }
        i += 3;
        continue;
      }
      default:
        if (!isAllowedHqWorkUrlByte(code)) return false;
    }
    i += 1;
  }
  return true;
}

function rawQueryValue(query: string, key: string): string | null {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    if (k !== key) continue;
    return eq === -1 ? '' : pair.slice(eq + 1);
  }
  return null;
}

/**
 * Parse `hqwork://open?channel=` / `person=` / `reply=` after validation.
 * Channel wins over person. Unknown / malformed → null (caller ignores).
 */
export function parseHqWorkOpenUrl(
  url: string | null | undefined,
): HqWorkOpenTarget | null {
  const raw = url?.trim() ?? '';
  if (!isValidHqWorkDeepLink(raw)) return null;
  const qStart = raw.indexOf('?');
  let query = raw.slice(qStart + 1);
  const hash = query.indexOf('#');
  if (hash >= 0) query = query.slice(0, hash);
  const channelId = hqworkQueryToken(rawQueryValue(query, 'channel'));
  const personUid = hqworkQueryToken(rawQueryValue(query, 'person'));
  const replyRootEventId = hqworkQueryToken(rawQueryValue(query, 'reply'));
  if (!channelId && !personUid) return null;
  return {
    channelId,
    personUid: channelId ? null : personUid,
    replyRootEventId,
  };
}
