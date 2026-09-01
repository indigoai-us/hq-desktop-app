import type { InvokeFn, PlatformAdapter } from "@hq/platform";
import {
  toSelfIdentity,
  type PutChatAttachment,
  type SelfIdentity,
} from "@hq/ui";

type ShellIdentityAdapter = Pick<PlatformAdapter, "kind" | "identity">;

export interface TauriAttachmentHandlers {
  putAttachmentObject: PutChatAttachment;
  getAttachmentObject: (url: string) => Promise<Response>;
}

export async function hydrateDesktopSelf(
  hostSelf: SelfIdentity | null,
  adapter: ShellIdentityAdapter,
): Promise<SelfIdentity | null> {
  if (hostSelf || adapter.kind !== "desktop") return hostSelf;
  try {
    const result = await adapter.identity.whoami();
    return result.ok
      ? toSelfIdentity({
          uid: result.value.personUid,
          email: result.value.email,
          displayName: result.value.displayName,
        })
      : null;
  } catch {
    return null;
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
    async getAttachmentObject(url): Promise<Response> {
      const result = (await invoke("vault_s3_get", { url })) as {
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
