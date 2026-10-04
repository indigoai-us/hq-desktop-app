import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

const INSTALL_ATTEMPT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_FLAGS_RESOLVE_URL = 'https://hqapi.hq.computer/v1/flags/resolve-public';

export type PublicFlagResponse = Pick<Response, 'ok' | 'json'>;
export type PublicFlagFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<PublicFlagResponse>;

export async function resolveFirstLaunchPublicFlag(
  flagKey: string,
  visitorId: string,
  fetchPublic: PublicFlagFetch = tauriFetch,
  warn: (message: string, error?: unknown) => void = (message) => console.warn(message),
): Promise<boolean> {
  if (!INSTALL_ATTEMPT_ID_RE.test(visitorId)) return false;
  try {
    const url = new URL(PUBLIC_FLAGS_RESOLVE_URL);
    url.searchParams.set('key', flagKey);
    url.searchParams.set('visitorId', visitorId);
    const response = await fetchPublic(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return typeof payload === 'object' && payload !== null &&
      'key' in payload && payload.key === flagKey &&
      'enabled' in payload && payload.enabled === true;
  } catch (error) {
    warn('first-launch public flag unavailable; staying off', error);
    return false;
  }
}
