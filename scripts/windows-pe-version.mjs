import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ResEdit from "resedit";

const APP_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Parse the app SemVer used on Windows PE VERSIONINFO. A fourth component is
 * optional; Tauri/winres stores it as zero when the cargo version is X.Y.Z.
 */
export function parseAppVersion(version) {
  const match = APP_VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(
      `Unsupported app version ${version}; expected X.Y.Z or X.Y.Z.N`,
    );
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    revision: Number(match[4] ?? 0),
    text: version,
  };
}

function fourPart(parsed) {
  return `${parsed.major}.${parsed.minor}.${parsed.patch}.${parsed.revision}`;
}

/**
 * Stamp FileVersion / ProductVersion (fixed info + string table) on existing
 * VERSIONINFO entries, or create a default en-US entry when the PE has none.
 */
export function applyVersionToResourceEntries(entries, version) {
  const parsed = parseAppVersion(version);
  const dotted = fourPart(parsed);
  let infos = ResEdit.Resource.VersionInfo.fromEntries(entries);

  if (infos.length === 0) {
    infos = [
      ResEdit.Resource.VersionInfo.create({
        lang: 1033,
        fixedInfo: {},
        strings: [{ lang: 1033, codepage: 1200, values: {} }],
      }),
    ];
  }

  for (const info of infos) {
    info.setFileVersion(dotted);
    info.setProductVersion(dotted);
    const languages = info.getAllLanguagesForStringValues();
    const tables = languages.length > 0 ? languages : [{ lang: 1033, codepage: 1200 }];
    for (const language of tables) {
      // Keep the original SemVer string (often three-part) so
      // FileVersionInfo.ProductVersion.StartsWith(target) matches CI.
      info.setStringValue(language, "FileVersion", parsed.text);
      info.setStringValue(language, "ProductVersion", parsed.text);
    }
    info.outputToResourceEntries(entries);
  }

  return infos.length;
}

export function patchPeVersionBuffer(buffer, version) {
  const exe = ResEdit.NtExecutable.from(buffer, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  applyVersionToResourceEntries(res.entries, version);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

export async function patchPeVersionFile(exePath, version) {
  const original = await readFile(exePath);
  const patched = patchPeVersionBuffer(original, version);
  const tempPath = `${exePath}.pe-version-tmp`;
  await writeFile(tempPath, patched);
  await rename(tempPath, exePath);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export async function main(args = process.argv.slice(2)) {
  const exePath = readOption(args, "--exe");
  if (!exePath) {
    throw new Error("--exe is required");
  }
  const version = readOption(args, "--version");
  if (!version) {
    throw new Error("--version is required");
  }

  await patchPeVersionFile(resolve(exePath), version);
  console.log(`Stamped PE FileVersion/ProductVersion ${version} on ${exePath}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
