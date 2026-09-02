import {
  GENERATED_MARKS_BASE_URL,
  HQ_AGENT_MASCOTS_BASE_URL,
  PACK_REGISTRY_STORAGE_KEY,
} from "./types.js";

export const DEFAULT_REMOTE_PACK_URLS: readonly string[] = [
  HQ_AGENT_MASCOTS_BASE_URL,
];

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  return (
    (globalThis as { window?: { localStorage?: Storage } }).window
      ?.localStorage ?? (globalThis.localStorage as Storage | undefined)
  );
}

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** True when a pack URL is a remote http(s) origin we can fetch pack.json from. */
export function isRemotePackUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function normalizePackUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (trimmed === GENERATED_MARKS_BASE_URL) return trimmed;
  if (!isRemotePackUrl(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export function parsePackRegistry(raw: unknown): string[] {
  if (!isRecordArray(raw)) return [...DEFAULT_REMOTE_PACK_URLS];
  const urls: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const normalized = normalizePackUrl(entry);
    if (!normalized || normalized === GENERATED_MARKS_BASE_URL) continue;
    if (!urls.includes(normalized)) urls.push(normalized);
  }
  return urls;
}

export function readPackRegistry(
  storage: Pick<Storage, "getItem"> | null | undefined = defaultStorage(),
): string[] {
  try {
    const raw = storage?.getItem(PACK_REGISTRY_STORAGE_KEY);
    if (!raw) return [...DEFAULT_REMOTE_PACK_URLS];
    return parsePackRegistry(JSON.parse(raw) as unknown);
  } catch {
    return [...DEFAULT_REMOTE_PACK_URLS];
  }
}

function persist(
  urls: string[],
  storage: Pick<Storage, "setItem"> | null | undefined,
): string[] {
  try {
    storage?.setItem(PACK_REGISTRY_STORAGE_KEY, JSON.stringify(urls));
  } catch {
    /* private mode */
  }
  return urls;
}

export function writePackRegistry(
  urls: readonly string[],
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | null
    | undefined = defaultStorage(),
): string[] {
  const next = parsePackRegistry(urls);
  return persist(next, storage);
}

export function addPackUrl(
  url: string,
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | null
    | undefined = defaultStorage(),
): { ok: true; urls: string[] } | { ok: false; error: string } {
  const normalized = normalizePackUrl(url);
  if (!normalized || normalized === GENERATED_MARKS_BASE_URL) {
    return { ok: false, error: "Enter an http(s) pack URL." };
  }
  const current = readPackRegistry(storage);
  if (current.includes(normalized)) {
    return { ok: true, urls: current };
  }
  return { ok: true, urls: persist([...current, normalized], storage) };
}

export function removePackUrl(
  url: string,
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | null
    | undefined = defaultStorage(),
): string[] {
  const normalized = normalizePackUrl(url) ?? url.trim().replace(/\/+$/, "");
  const current = readPackRegistry(storage);
  return persist(
    current.filter((entry) => entry !== normalized),
    storage,
  );
}
