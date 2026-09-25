/**
 * Vault buckets have S3 Object Lock, which refuses any PUT without a signed
 * content checksum. hq-pro signs `x-amz-checksum-sha256` only when the presign
 * carries `checksumSha256` plus the matching `hq-content-sha256` metadata, so
 * the adapter must forward both. Before this, every chat attachment upload
 * failed and bots never received a file.
 */
import { describe, expect, it } from "vitest";

import { vaultPutIntegrityFields } from "../adapter.js";
import { WebPlatformAdapter } from "./index.js";

function makeAdapter() {
  const bodies: unknown[] = [];
  const fetchMock: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  return {
    adapter: new WebPlatformAdapter({ baseUrl: "https://api.test", fetch: fetchMock }),
    bodies,
  };
}

const integrity = {
  checksumSha256: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
  contentSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};

describe("presignVaultPut", () => {
  it("sends the checksum and the matching content-hash metadata", async () => {
    const { adapter, bodies } = makeAdapter();
    await adapter.files.presignVaultPut("prs_me", "chat/attachments/dm/a--b/x.pdf", "application/pdf", integrity);
    expect(bodies).toEqual([
      {
        company: "prs_me",
        op: "put",
        key: "chat/attachments/dm/a--b/x.pdf",
        contentType: "application/pdf",
        checksumSha256: integrity.checksumSha256,
        metadata: { "hq-content-sha256": integrity.contentSha256 },
      },
    ]);
  });

  it("sends the plain request when no digest is given", async () => {
    const { adapter, bodies } = makeAdapter();
    await adapter.files.presignVaultPut("cmp_1", "k", "text/plain");
    expect(bodies).toEqual([{ company: "cmp_1", op: "put", key: "k", contentType: "text/plain" }]);
  });
});

describe("vaultPutIntegrityFields", () => {
  it("is empty without a digest", () => {
    expect(vaultPutIntegrityFields(undefined)).toEqual({});
  });
});
