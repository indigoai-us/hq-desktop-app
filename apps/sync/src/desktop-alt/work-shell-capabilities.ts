/**
 * Native capabilities for a future @hq/work WorkShell mount.
 *
 * This module is deliberately not imported by the desktop-alt entrypoint yet:
 * Step 3 owns the mount. Keeping the capabilities here makes the command-only
 * transport testable without making the default-off embedded bundle eager.
 */
import {
  loadVaultFilePreview,
  type ChannelFileItemModel,
  type ChannelFilePreview,
} from '@hq/ui';
import { getVaultObject } from './vault-s3-put';

export type NativeInvokeFn = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type HqProFetch = typeof globalThis.fetch;
type VaultObjectGetter = typeof getVaultObject;

interface NativeHqProResponse {
  status: number;
  body: string;
}

interface NativeAuthSession {
  status?: unknown;
}

interface NativeWhoAmI {
  personUid?: unknown;
  email?: unknown;
  displayName?: unknown;
}

export interface NativeWorkShellCapabilities {
  runtimeKind: 'desktop';
  fetch: HqProFetch;
  onUnauthorized: () => void;
  loadFilePreview: (
    item: ChannelFileItemModel,
    selectedCompanyUid: string | null | undefined,
  ) => Promise<ChannelFilePreview>;
  hostIdentity: {
    sub: string;
    email?: string;
    name?: string;
  } | null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function requestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | null> {
  if (init?.body !== undefined) {
    if (init.body === null) return null;
    return new Response(init.body).text();
  }
  if (input instanceof Request) {
    const body = await input.clone().text();
    return body || null;
  }
  return null;
}

/**
 * hq-pro fetch shape backed exclusively by Sync's authenticated Rust command.
 * The webview never reads a browser token or makes a browser network request.
 */
export function createNativeHqProFetch(
  invoke: NativeInvokeFn,
  onUnauthorized?: () => void,
): HqProFetch {
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const response = await invoke<NativeHqProResponse>('hq_pro_fetch', {
      url: requestUrl(input),
      method,
      body: await requestBody(input, init),
    });
    if (response.status === 401) onUnauthorized?.();
    return new Response(response.status === 204 ? null : response.body, {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function createNativeVaultFilePreviewLoader(
  fetch: HqProFetch,
  get: VaultObjectGetter,
): NativeWorkShellCapabilities['loadFilePreview'] {
  return async (item, selectedCompanyUid) =>
    loadVaultFilePreview({
      item,
      selectedCompanyUid,
      presign: async (companyUid, key) => {
        try {
          const response = await fetch('/v1/files/presign', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ company: companyUid, op: 'get', key }),
          });
          if (!response.ok) {
            return {
              ok: false,
              code: `http-${response.status}`,
              message: response.statusText,
            };
          }
          return { ok: true, value: await response.json() };
        } catch (error) {
          return {
            ok: false,
            reason: error instanceof Error ? error.message : 'native command failed',
          };
        }
      },
      get,
    });
}

async function nativeHostIdentity(
  invoke: NativeInvokeFn,
): Promise<NativeWorkShellCapabilities['hostIdentity']> {
  try {
    const session = await invoke<NativeAuthSession>('get_auth_session');
    if (session.status !== 'active') return null;
    const whoami = await invoke<NativeWhoAmI>('whoami');
    const sub = typeof whoami.personUid === 'string' ? whoami.personUid.trim() : '';
    if (!sub) return null;
    const email = typeof whoami.email === 'string' ? whoami.email.trim() : '';
    const name =
      typeof whoami.displayName === 'string' ? whoami.displayName.trim() : '';
    return {
      sub,
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
    };
  } catch {
    return null;
  }
}

export async function createNativeWorkShellCapabilities(options: {
  invoke: NativeInvokeFn;
  getVaultObject?: VaultObjectGetter;
  hostIdentity?: NativeWorkShellCapabilities['hostIdentity'];
  onUnauthorized?: () => void;
}): Promise<NativeWorkShellCapabilities> {
  const onUnauthorized = options.onUnauthorized ?? (() => {
    void options.invoke<void>('sign_out').catch(() => undefined);
  });
  const fetch = createNativeHqProFetch(options.invoke, onUnauthorized);
  return {
    runtimeKind: 'desktop',
    fetch,
    onUnauthorized,
    loadFilePreview: createNativeVaultFilePreviewLoader(
      fetch,
      options.getVaultObject ?? getVaultObject,
    ),
    hostIdentity: options.hostIdentity ?? await nativeHostIdentity(options.invoke),
  };
}
