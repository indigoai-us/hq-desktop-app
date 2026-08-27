/**
 * Desktop hop for chat-attachment bytes. The webview cannot PUT/GET vault
 * S3 (no CORS). Rust sends the presigned request instead.
 */
import { invoke } from '@tauri-apps/api/core';

export async function putVaultObject(
  url: string,
  headers: Record<string, string>,
  file: File,
): Promise<Response> {
  const body = Array.from(new Uint8Array(await file.arrayBuffer()));
  const status = await invoke<number>('vault_s3_put', { url, headers, body });
  return new Response(null, { status });
}

/** Desktop hop for chat-attachment GET. Webview fetch() of S3 has no CORS. */
export async function getVaultObject(url: string): Promise<Response> {
  const result = await invoke<{
    status: number;
    contentType: string;
    body: number[];
  }>('vault_s3_get', { url });
  return new Response(Uint8Array.from(result.body), {
    status: result.status,
    headers: {
      'content-type': result.contentType || 'application/octet-stream',
    },
  });
}
