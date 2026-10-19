import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MeshCredentialBundle } from "./credentials.js";
import type { SigV4Crypto } from "./presign.js";

// mqtt.js is loaded on the first connect, not with the module. The mock
// records when the load happens and hands back a fake client.
const loads = vi.hoisted(() => ({ count: 0, urls: [] as string[] }));
vi.mock("mqtt", () => {
  loads.count++;
  return {
    default: {
      connect: (url: string) => {
        loads.urls.push(url);
        return { on: () => undefined, subscribe: () => undefined, end: () => undefined };
      },
    },
  };
});

const syncSigV4Crypto: SigV4Crypto = {
  sha256Hex: (data) => Promise.resolve(createHash("sha256").update(data).digest("hex")),
  hmac: (key, data) =>
    Promise.resolve(new Uint8Array(createHmac("sha256", key).update(data).digest())),
};

function bundle(): MeshCredentialBundle {
  return {
    credentials: {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "token",
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
    },
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
    iotEndpoint: "example-ats.iot.us-east-1.amazonaws.com",
    region: "us-east-1",
    personUid: "prs_a",
    companyTopics: [],
  } as unknown as MeshCredentialBundle;
}

describe("MeshClient loads mqtt.js on first connect", () => {
  it("does not import mqtt as a value at module load", () => {
    const src = readFileSync(join(__dirname, "client.ts"), "utf8");
    expect(src).not.toMatch(/^import\s+mqtt\b/m);
    expect(src).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+["']mqtt["']/m);
    expect(src).toContain('import("mqtt")');
  });

  it("connects through the lazily loaded mqtt.js when no seam is injected", async () => {
    const { MeshClient } = await import("./client.js");
    expect(loads.count).toBe(0);
    const client = new MeshClient({
      credentialProvider: { fetchCredentials: () => Promise.resolve(bundle()) },
      fetcher: () => Promise.resolve({ state: {}, cursor: undefined }),
      sigv4Crypto: syncSigV4Crypto,
      visibilityHost: null,
    });
    await client.start();
    for (let i = 0; i < 10 && loads.urls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(loads.count).toBe(1);
    expect(loads.urls).toHaveLength(1);
    expect(loads.urls[0]).toMatch(/^wss:\/\/example-ats\.iot\.us-east-1\.amazonaws\.com/);
    client.stop();
  });
});
