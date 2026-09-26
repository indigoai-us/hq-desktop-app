#!/usr/bin/env node
// Size guard for prebuilt-shell archives before they go to the rolling
// `shell-cache` prerelease (docs/RELEASE.md "Prebuilt shell"). GitHub rejects
// release assets of 2 GiB or more with an opaque "HTTP 422: Validation
// Failed", which is how the uncompressed Windows shells first failed. The
// shell jobs run this on the archive before uploading so an oversized shell
// fails with a message that names the file and the limit.
//
// Usage:
//   node scripts/shell-archive.mjs check-size <archive> [--max-bytes N]
// Prints "<bytes> bytes (<MiB> MiB)" and exits 0, or exits 1 with an error.
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GITHUB_ASSET_LIMIT_BYTES = 2 * 1024 ** 3;
// 1.8 GiB leaves headroom so growth is caught before GitHub's limit.
export const MAX_SHELL_ARCHIVE_BYTES = Math.floor(1.8 * 1024 ** 3);

const mib = (bytes) => (bytes / 1024 ** 2).toFixed(1);

/** @returns {{ ok: true, message: string } | { ok: false, message: string }} */
export function checkArchiveSize(name, bytes, maxBytes = MAX_SHELL_ARCHIVE_BYTES) {
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new Error(`shell-archive: invalid size ${bytes} for ${name}`);
  }
  if (bytes === 0) {
    return { ok: false, message: `${name} is empty; the shell was not packaged.` };
  }
  if (bytes > maxBytes) {
    return {
      ok: false,
      message:
        `${name} is ${bytes} bytes (${mib(bytes)} MiB), over the ${maxBytes}-byte (${mib(maxBytes)} MiB) shell archive cap. ` +
        `GitHub rejects release assets of ${GITHUB_ASSET_LIMIT_BYTES} bytes or more with HTTP 422, so this shell cannot be stored on shell-cache. ` +
        "Shrink the archive (exclude more build output or raise the compression level) before retrying.",
    };
  }
  return { ok: true, message: `${name}: ${bytes} bytes (${mib(bytes)} MiB)` };
}

function main(argv) {
  const [command, file, ...rest] = argv;
  if (command !== "check-size" || !file) {
    throw new Error("usage: shell-archive.mjs check-size <archive> [--max-bytes N]");
  }
  let maxBytes = MAX_SHELL_ARCHIVE_BYTES;
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== "--max-bytes") throw new Error(`shell-archive: unknown flag ${rest[i]}`);
    maxBytes = Number(rest[i + 1]);
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new Error(`shell-archive: --max-bytes must be a positive integer, got ${rest[i + 1]}`);
    }
  }
  const result = checkArchiveSize(file, statSync(file).size, maxBytes);
  if (!result.ok) {
    console.error(`::error::${result.message}`);
    process.exit(1);
  }
  console.log(result.message);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
