import type { InvokeFn, PlatformAdapter } from "@hq/platform";
import {
  toSelfIdentity,
  type PutChatAttachment,
  type SelfIdentity,
} from "@hq/ui";

type ShellIdentityAdapter = Pick<PlatformAdapter, "kind" | "identity">;

export interface HydrateDesktopSelfOptions {
  sleep?: (ms: number) => Promise<void>;
}

export interface TauriAttachmentHandlers {
  putAttachmentObject: PutChatAttachment;
  getAttachmentObject: (url: string, maxBytes?: number) => Promise<Response>;
}

export interface ShellSignOutOptions {
  adapter: Pick<PlatformAdapter, "kind">;
  invoke: InvokeFn;
  navigate: (url: string) => void;
  onDesktopSignedOut: () => void;
}

export type NativeAuthSessionStatus =
  | "active"
  | "credentials_absent"
  | "credentials_invalid"
  | "refresh_temporarily_unavailable";

export interface NativeAuthSession {
  accountId: string | null;
  generation: number;
  status: NativeAuthSessionStatus;
}

function isNativeAuthSessionStatus(
  value: unknown,
): value is NativeAuthSessionStatus {
  return (
    value === "active" ||
    value === "credentials_absent" ||
    value === "credentials_invalid" ||
    value === "refresh_temporarily_unavailable"
  );
}

export function nativeTenantFromSession(
  value: unknown,
): NativeAuthSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Record<string, unknown>;
  const accountId =
    typeof session.accountId === "string" && session.accountId.trim()
      ? session.accountId.trim()
      : null;
  const generation = session.generation;
  const status = session.status;
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !isNativeAuthSessionStatus(status)
  ) {
    return null;
  }
  return { accountId, generation, status };
}

/**
 * The desktop owns its persistent Cognito tokens, while the web shell owns a
 * cookie-backed session route. Do not navigate a static Tauri build to the web
 * route: it cannot clear the native token store.
 */
export async function signOutFromShell({
  adapter,
  invoke,
  navigate,
  onDesktopSignedOut,
}: ShellSignOutOptions): Promise<void> {
  if (adapter.kind === "desktop") {
    await invoke("sign_out");
    onDesktopSignedOut();
    return;
  }
  navigate("/auth/signout");
}

export async function hydrateDesktopSelf(
  hostSelf: SelfIdentity | null,
  adapter: ShellIdentityAdapter,
  options: HydrateDesktopSelfOptions = {},
): Promise<SelfIdentity | null> {
  if (!hostSelf && adapter.kind === "web") return null;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = adapter.kind === "web" ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await adapter.identity.whoami();
      if (result.ok) {
        return toSelfIdentity({
          uid: result.value.personUid,
          email: result.value.email,
          displayName: result.value.displayName,
        });
      }
    } catch {
      // A valid hosted session can outlive a transient whoami request failure.
    }
    if (attempt < attempts - 1) await sleep((attempt + 1) * 100);
  }
  return adapter.kind === "desktop" ? hostSelf : null;
}

export function createTauriAttachmentHandlers(
  invoke: InvokeFn,
): TauriAttachmentHandlers {
  return {
    async putAttachmentObject(url, headers, file): Promise<Response> {
      const body = Array.from(new Uint8Array(await file.arrayBuffer()));
      const status = (await invoke("vault_s3_put", {
        url,
        headers,
        body,
      })) as number;
      return new Response(null, { status });
    },
    async getAttachmentObject(url, maxBytes): Promise<Response> {
      const result = (await invoke("vault_s3_get", {
        url,
        ...(maxBytes ? { maxBytes } : {}),
      })) as {
        status: number;
        contentType: string;
        body: number[];
      };
      return new Response(Uint8Array.from(result.body), {
        status: result.status,
        headers: {
          "content-type": result.contentType || "application/octet-stream",
        },
      });
    },
  };
}
