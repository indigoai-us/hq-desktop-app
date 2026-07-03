import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_FILE = "versions.toml";
const BASE_CRATE = "hq-sync-menubar";

type VersionTarget = {
  path: string;
  stamp: (text: string, version: string) => string;
};

export type VersionAppResult = {
  version: string;
  changes: string[];
  ok: boolean;
};

export type VersionAppOptions = {
  rootDir?: string;
  check?: boolean;
};

const targets: VersionTarget[] = [
  {
    path: "apps/sync/package.json",
    stamp: stampJsonVersion,
  },
  {
    path: "apps/sync/src-tauri/tauri.conf.json",
    stamp: stampJsonVersion,
  },
  {
    path: "apps/sync/src-tauri/Cargo.toml",
    stamp: (text, version) => stampTomlTableVersion(text, "package", version),
  },
  {
    path: "apps/sync/src-tauri/Cargo.lock",
    stamp: (text, version) => stampCargoLockPackageVersion(text, BASE_CRATE, version),
  },
];

const defaultRootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function readVersionFromVersionsToml(text: string): string {
  const product = readTomlTable(text, "product");
  const match = /^version\s*=\s*"([^"]+)"\s*(?:#.*)?$/m.exec(product);

  if (!match) {
    throw new Error(`${VERSION_FILE} is missing [product] version = "..."`);
  }

  return match[1];
}

export async function runVersionApp(options: VersionAppOptions = {}): Promise<VersionAppResult> {
  const rootDir = resolve(options.rootDir ?? defaultRootDir);
  const versionFile = join(rootDir, VERSION_FILE);
  const version = readVersionFromVersionsToml(await readFile(versionFile, "utf8"));
  const changes: string[] = [];

  for (const target of targets) {
    const file = join(rootDir, target.path);
    const original = await readFile(file, "utf8");
    const stamped = target.stamp(original, version);

    if (stamped !== original) {
      changes.push(target.path);

      if (!options.check) {
        await writeFile(file, stamped);
      }
    }
  }

  return {
    version,
    changes,
    ok: changes.length === 0,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { check, rootDir, help } = parseArgs(argv);

  if (help) {
    console.log("Usage: tsx scripts/version-app.ts [--check] [--root <dir>]");
    return 0;
  }

  const result = await runVersionApp({ check, rootDir });

  if (check && !result.ok) {
    console.error(`App version files differ from ${VERSION_FILE} (${result.version}):`);
    for (const changed of result.changes) {
      console.error(`- ${changed}`);
    }
    return 1;
  }

  if (check) {
    console.log(`App version files match ${VERSION_FILE} (${result.version}).`);
    return 0;
  }

  if (result.ok) {
    console.log(`App version files already match ${VERSION_FILE} (${result.version}).`);
  } else {
    console.log(`Stamped app version ${result.version} in ${result.changes.length} file(s).`);
  }

  return 0;
}

function parseArgs(argv: string[]): { check: boolean; help: boolean; rootDir?: string } {
  let check = false;
  let help = false;
  let rootDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--check") {
      check = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--root") {
      const next = argv[i + 1];

      if (!next) {
        throw new Error("--root requires a directory");
      }

      rootDir = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { check, help, rootDir };
}

function stampJsonVersion(text: string, version: string): string {
  const json = JSON.parse(text) as { version?: unknown };

  if (json.version === version) {
    return text;
  }

  json.version = version;
  return `${JSON.stringify(json, null, 2)}${detectFinalNewline(text)}`;
}

function stampTomlTableVersion(text: string, table: string, version: string): string {
  const lines = splitLines(text);
  let inTable = false;
  let replaced = false;

  const next = lines.map((line) => {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?\r?\n?$/.exec(line);

    if (header) {
      inTable = header[1] === table;
      return line;
    }

    if (inTable) {
      const versionLine = /^(\s*version\s*=\s*")([^"]*)(".*)$/s.exec(line);

      if (versionLine) {
        replaced = true;
        return `${versionLine[1]}${version}${versionLine[3]}`;
      }
    }

    return line;
  });

  if (!replaced) {
    throw new Error(`Missing version in [${table}]`);
  }

  return next.join("");
}

function stampCargoLockPackageVersion(text: string, packageName: string, version: string): string {
  let found = false;
  const blocks = text.split(/(?=^\[\[package\]\]\r?$)/m);
  const stamped = blocks.map((block) => {
    if (!block.startsWith("[[package]]")) {
      return block;
    }

    const name = /^name = "([^"]+)"/m.exec(block);

    if (name?.[1] !== packageName) {
      return block;
    }

    found = true;

    if (!/^version = "[^"]+"/m.test(block)) {
      throw new Error(`Missing version for ${packageName} in Cargo.lock`);
    }

    return block.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  });

  if (!found) {
    throw new Error(`Missing ${packageName} in Cargo.lock`);
  }

  return stamped.join("");
}

function readTomlTable(text: string, table: string): string {
  const header = new RegExp(`^\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?$`, "m");
  const match = header.exec(text);

  if (!match) {
    throw new Error(`${VERSION_FILE} is missing [${table}]`);
  }

  const start = match.index + match[0].length;
  const nextTable = /^\[[^\]]+\]\s*(?:#.*)?$/m.exec(text.slice(start));
  const end = nextTable ? start + nextTable.index : text.length;

  return text.slice(start, end);
}

function splitLines(text: string): string[] {
  const lines = text.match(/.*(?:\r?\n|$)/g) ?? [];
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function detectFinalNewline(text: string): string {
  if (text.endsWith("\r\n")) {
    return "\r\n";
  }

  return text.endsWith("\n") ? "\n" : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCliEntrypoint(metaUrl: string): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

if (isCliEntrypoint(import.meta.url)) {
  main().then((status) => {
    process.exitCode = status;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
