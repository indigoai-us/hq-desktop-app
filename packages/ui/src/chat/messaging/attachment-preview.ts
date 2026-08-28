/**
 * Shared attachment preview helpers (message strip + tray).
 */

export type AttachmentPreviewKind =
  "image" | "text" | "markdown" | "pdf" | "sheet" | "file";

export function isNetworkFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /failed to fetch|networkerror|^load failed$/i.test(err.message);
}

export function attachmentPreviewKind(input: {
  name: string;
  contentType: string;
  kind?: string | null;
}): AttachmentPreviewKind {
  const name = input.name.trim().toLowerCase();
  const ct = input.contentType.trim().toLowerCase();
  if (
    input.kind === "image" ||
    ct.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic)(?:[?#].*)?$/i.test(name)
  ) {
    return "image";
  }
  if (ct === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    ct === "text/csv" ||
    name.endsWith(".csv") ||
    ct.includes("spreadsheet") ||
    ct === "application/vnd.ms-excel" ||
    name.endsWith(".xlsx") ||
    name.endsWith(".xls")
  ) {
    return "sheet";
  }
  if (
    ct === "text/markdown" ||
    name.endsWith(".md") ||
    name.endsWith(".markdown")
  ) {
    return "markdown";
  }
  if (
    ct.startsWith("text/") ||
    ct === "application/json" ||
    name.endsWith(".txt") ||
    name.endsWith(".json")
  ) {
    return "text";
  }
  return "file";
}

export function parseCsv(text: string, maxRows = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((part) => part.trim().length > 0)) rows.push(row);
      row = [];
      if (rows.length >= maxRows) break;
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((part) => part.trim().length > 0)) rows.push(row);
  }
  return rows;
}

function isHtmlDocument(res: Response): boolean {
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  return type.includes("text/html");
}

/** True when this origin is the Work web app (has /api/chat-attachment-bytes).
 * Desktop Vite (port 1420) has no such route — it returns index.html. */
export function canUseWebAttachmentProxy(origin: string): boolean {
  const value = origin.trim();
  if (!value.startsWith("http://") && !value.startsWith("https://"))
    return false;
  try {
    const url = new URL(value);
    if (url.port === "1420") return false;
    return true;
  } catch {
    return false;
  }
}

export async function readAttachmentResponse(url: string): Promise<Response> {
  try {
    const direct = await fetch(url);
    if (direct.ok && !isHtmlDocument(direct)) return direct;
  } catch (err) {
    if (!isNetworkFetchError(err)) throw err;
  }
  const origin =
    typeof window !== "undefined" ? (window.location?.origin ?? "") : "";
  if (canUseWebAttachmentProxy(origin)) {
    const proxied = await fetch("/api/chat-attachment-bytes", {
      headers: { "x-hq-source-url": url },
    });
    if (proxied.ok && !isHtmlDocument(proxied)) return proxied;
  }
  throw new Error("Could not load the file");
}

export async function downloadAttachment(
  url: string,
  name: string,
): Promise<void> {
  const res = await readAttachmentResponse(url);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = name || "download";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function textFromUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function findZipEntry(
  bytes: Uint8Array,
  name: string,
): {
  offset: number;
  method: number;
  compSize: number;
  uncompSize: number;
} | null {
  const needle = new TextEncoder().encode(name);
  for (let i = 0; i < bytes.length - 30; i += 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    ) {
      const method = bytes[i + 8]! | (bytes[i + 9]! << 8);
      const compSize =
        bytes[i + 18]! |
        (bytes[i + 19]! << 8) |
        (bytes[i + 20]! << 16) |
        (bytes[i + 21]! << 24);
      const uncompSize =
        bytes[i + 22]! |
        (bytes[i + 23]! << 8) |
        (bytes[i + 24]! << 16) |
        (bytes[i + 25]! << 24);
      const nameLen = bytes[i + 26]! | (bytes[i + 27]! << 8);
      const extraLen = bytes[i + 28]! | (bytes[i + 29]! << 8);
      const nameStart = i + 30;
      const entryName = textFromUtf8(
        bytes.subarray(nameStart, nameStart + nameLen),
      );
      if (entryName === name || entryName.endsWith(`/${name}`)) {
        return {
          offset: nameStart + nameLen + extraLen,
          method,
          compSize,
          uncompSize,
        };
      }
      i = nameStart + nameLen + extraLen + compSize - 1;
    }
  }
  return null;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("deflate is not available");
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipFile(
  bytes: Uint8Array,
  name: string,
): Promise<string | null> {
  const entry = findZipEntry(bytes, name);
  if (!entry) return null;
  const slice = bytes.subarray(entry.offset, entry.offset + entry.compSize);
  if (entry.method === 0) return textFromUtf8(slice);
  if (entry.method === 8) return textFromUtf8(await inflateRaw(slice));
  return null;
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const blocks = xml.split(/<si[\s>]/).slice(1);
  for (const block of blocks) {
    const texts = [...block.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) =>
      decodeXmlEntities(m[1] ?? ""),
    );
    out.push(texts.join(""));
  }
  return out;
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch < "A" || ch > "Z") break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return Math.max(0, n - 1);
}

function parseSheetXml(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowBlocks = xml.split(/<row[\s>]/).slice(1);
  for (const block of rowBlocks.slice(0, 200)) {
    const cells: string[] = [];
    const cellRe = /<c([^>]*)>(?:<v>([^<]*)<\/v>|<is>([\s\S]*?)<\/is>)?/g;
    let match: RegExpExecArray | null;
    while ((match = cellRe.exec(block))) {
      const attrs = match[1] ?? "";
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
      const idx = colIndex(ref);
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = match[2] ?? "";
      if (type === "s") value = shared[Number(value)] ?? "";
      if (type === "inlineStr") {
        const texts = [
          ...(match[3] ?? "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g),
        ];
        value = texts.map((t) => decodeXmlEntities(t[1] ?? "")).join("");
      }
      while (cells.length < idx) cells.push("");
      cells[idx] = value;
    }
    if (cells.some((cell) => cell.trim())) rows.push(cells);
  }
  return rows;
}

export async function parseSpreadsheetBytes(
  name: string,
  bytes: ArrayBuffer,
): Promise<string[][] | null> {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    return parseCsv(textFromUtf8(new Uint8Array(bytes)));
  }
  if (!lower.endsWith(".xlsx")) return null;
  const zip = new Uint8Array(bytes);
  const sharedXml = await readZipFile(zip, "xl/sharedStrings.xml");
  const sheetXml =
    (await readZipFile(zip, "xl/worksheets/sheet1.xml")) ??
    (await readZipFile(zip, "xl/worksheets/sheet.xml"));
  if (!sheetXml) return null;
  return parseSheetXml(
    sheetXml,
    sharedXml ? parseSharedStrings(sharedXml) : [],
  );
}
