/**
 * The in-window device signing key (US-016 scope).
 *
 * `createHqSignalingPort` signs every control/signal envelope with an
 * `EnvelopeSigner`. For this story the call window mints an ephemeral Ed25519
 * key pair with WebCrypto, exports the raw public key, and derives
 * `peerKey = keyId(rawPublicKey)` exactly as `@hq/platform`'s verifier does —
 * so an envelope this window signs verifies against the same `verifyEnvelope`
 * the service mirror uses.
 *
 * The private key is `extractable: false` and never leaves this webview: it is
 * not persisted, not logged, and never crosses the invoke seam. US-017 replaces
 * it with the account-bound device key.
 */

import { keyId, signedBytes, toBase64Url } from "@hq/platform";

export interface DeviceSigner {
  /** sha256 of the raw public key — the contract's `peerKey`. */
  readonly peerKey: string;
  /** Raw public key, base64url. Handed to a verifier, never to a log. */
  readonly publicKey: string;
  sign(envelope: Record<string, unknown>): Promise<string>;
}

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto;
  if (!webcrypto?.subtle) {
    throw new Error("WebCrypto (crypto.subtle) is required for hq-meet/1");
  }
  return webcrypto.subtle;
}

/** Generate this window's device key and return a ready `EnvelopeSigner`. */
export async function createDeviceSigner(): Promise<DeviceSigner> {
  const pair = (await subtle().generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  const publicKey = toBase64Url(raw);
  const peerKey = await keyId(publicKey);

  return {
    peerKey,
    publicKey,
    async sign(envelope: Record<string, unknown>): Promise<string> {
      const message = signedBytes(envelope);
      const signature = new Uint8Array(
        // The view goes straight in: `.buffer` would hand `subtle.sign` the
        // whole backing store, which is only the same bytes when the view
        // happens to span it exactly. The cast is purely to satisfy
        // `BufferSource`, whose lib.dom typing wants an `ArrayBuffer`-backed
        // view; the bytes, offset and length are unchanged.
        await subtle().sign(
          { name: "Ed25519" },
          pair.privateKey,
          message as Uint8Array<ArrayBuffer>,
        ),
      );
      return toBase64Url(signature);
    },
  };
}
