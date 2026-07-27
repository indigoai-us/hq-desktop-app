import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APP_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:beta|alpha)\.(0|[1-9][0-9]*))?$/;

const WIX_LIMITS = [
  ["major", 255n],
  ["minor", 255n],
  ["patch", 65_535n],
];

export function deriveWindowsMsiVersion(appVersion) {
  const match = APP_VERSION_PATTERN.exec(appVersion);
  if (!match) {
    throw new Error(
      `Unsupported app version ${appVersion}; expected X.Y.Z, X.Y.Z-beta.N, or X.Y.Z-alpha.N`,
    );
  }

  const components = match.slice(1, 4);
  components.forEach((component, index) => {
    const [field, limit] = WIX_LIMITS[index];
    if (BigInt(component) > limit) {
      throw new Error(
        `Windows MSI ${field} version ${component} exceeds WiX limit ${limit}`,
      );
    }
  });

  // Windows Installer compares only the first three ProductVersion fields.
  // Keep the full SemVer on the app, NSIS installer, updater, and filenames;
  // this value exists only to make the WiX/MSI package metadata numeric.
  return components.join(".");
}

export async function writeWindowsMsiVersionConfig(outputPath, appVersion) {
  const version = deriveWindowsMsiVersion(appVersion);
  const config = {
    bundle: {
      windows: {
        wix: {
          version,
        },
      },
    },
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return version;
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

async function main(args = process.argv.slice(2)) {
  const appVersion = readOption(args, "--version");
  if (!appVersion) {
    throw new Error("--version is required");
  }

  const outputPath = readOption(args, "--output");
  if (outputPath) {
    const msiVersion = await writeWindowsMsiVersionConfig(outputPath, appVersion);
    console.log(
      `Wrote Windows MSI ProductVersion ${msiVersion} for app ${appVersion} to ${outputPath}`,
    );
  } else {
    console.log(deriveWindowsMsiVersion(appVersion));
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
