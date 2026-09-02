import { generatedMarksPack } from "./generated-marks.js";
import { packJsonUrl, parseAvatarPack, trimSlash } from "./parse-pack.js";
import { readPackRegistry } from "./registry.js";
import { bundledSnapshotFor } from "./snapshots.js";
import { GENERATED_MARKS_BASE_URL, type AvatarPack } from "./types.js";

export type PackFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type PackSource = "remote" | "fallback" | "builtin";

export interface LoadedPack {
  pack: AvatarPack;
  source: PackSource;
}

export function defaultPackFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const parent = init?.signal;
  const onAbort = () => controller.abort();
  parent?.addEventListener("abort", onAbort);
  return fetch(url, { credentials: "include", ...init, signal: controller.signal }).finally(
    () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  );
}

async function readJson(
  response: Response,
): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

/**
 * Fetch `${baseUrl}/pack.json` with credentialed fetch; fall back to a bundled
 * snapshot when the live manifest is missing or invalid.
 */
export async function loadPackFromUrl(
  baseUrl: string,
  opts: {
    fetch?: PackFetch;
    fallback?: AvatarPack | null;
  } = {},
): Promise<LoadedPack> {
  const fetchFn = opts.fetch ?? defaultPackFetch;
  const fallback =
    opts.fallback === undefined
      ? bundledSnapshotFor(baseUrl)
      : opts.fallback;
  const url = packJsonUrl(baseUrl);
  try {
    const response = await fetchFn(url);
    if (response.ok) {
      const parsed = parseAvatarPack(await readJson(response));
      if (parsed.ok) {
        return {
          pack: { ...parsed.pack, baseUrl: trimSlash(baseUrl) || parsed.pack.baseUrl },
          source: "remote",
        };
      }
    }
  } catch {
    /* gated host / offline / invalid JSON */
  }
  if (fallback) {
    return {
      pack: { ...fallback, baseUrl: trimSlash(baseUrl) || fallback.baseUrl },
      source: "fallback",
    };
  }
  throw new Error(`Could not load avatar pack from ${baseUrl}`);
}

export async function loadRegisteredPacks(
  opts: {
    fetch?: PackFetch;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
    generated?: AvatarPack;
  } = {},
): Promise<LoadedPack[]> {
  const generated: LoadedPack = {
    pack: opts.generated ?? generatedMarksPack(),
    source: "builtin",
  };
  const urls = readPackRegistry(opts.storage).filter(
    (url) => url !== GENERATED_MARKS_BASE_URL,
  );
  const remote = await Promise.all(
    urls.map(async (url) => {
      try {
        return await loadPackFromUrl(url, { fetch: opts.fetch });
      } catch {
        return null;
      }
    }),
  );
  return [generated, ...remote.filter((row): row is LoadedPack => row !== null)];
}
