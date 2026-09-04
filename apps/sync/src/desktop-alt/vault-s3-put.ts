/**
 * Desktop hop for chat-attachment bytes. The webview cannot PUT/GET vault
 * S3 (no CORS). Rust sends the presigned request instead.
 */
import { invoke } from '@tauri-apps/api/core';

/**
 * Desktop hop for vault GET. An optional preview limit is enforced in Rust
 * before response bytes are buffered in the webview.
 */
export async function getVaultObject(
  url: string,
  maxBytes?: number,
): Promise<Response> {
  const result = await invoke<{
    status: number;
    contentType: string;
    body: number[];
  }>('vault_s3_get', { url, ...(maxBytes ? { maxBytes } : {}) });
  return new Response(Uint8Array.from(result.body), {
    status: result.status,
    headers: {
      'content-type': result.contentType || 'application/octet-stream',
    },
  });
}
