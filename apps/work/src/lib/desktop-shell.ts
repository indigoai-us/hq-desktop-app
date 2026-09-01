import type { InvokeFn, PlatformAdapter } from "@hq/platform";
import {
  toSelfIdentity,
  type PutChatAttachment,
  type SelfIdentity,
} from "@hq/ui";

type ShellIdentityAdapter = Pick<PlatformAdapter, "kind" | "identity">;

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
): Promise<SelfIdentity | null> {
  if (!hostSelf && adapter.kind === "web") return null;
  try {
    const result = await adapter.identity.whoami();
    return result.ok
      ? toSelfIdentity({
          uid: result.value.personUid,
          email: result.value.email,
          displayName: result.value.displayName,
        })
      : adapter.kind === "desktop" ? hostSelf : null;
  } catch {
    return adapter.kind === "desktop" ? hostSelf : null;
  }
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
