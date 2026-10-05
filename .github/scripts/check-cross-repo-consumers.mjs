import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "../..");
const entryKeys = ["consumers", "path", "required_tokens"];
const consumerKeys = ["file", "repo"];

function fail(message) {
  throw new Error(message);
}

function validateManifest(manifest) {
  if (!Array.isArray(manifest)) {
    fail("Cross-repo consumer manifest must be a JSON array");
  }

  for (const [index, entry] of manifest.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`Manifest entry ${index + 1} must be an object`);
    }
    const actualEntryKeys = Object.keys(entry).sort();
    if (JSON.stringify(actualEntryKeys) !== JSON.stringify(entryKeys)) {
      fail(`Manifest entry ${index + 1} must contain only path, consumers, and required_tokens`);
    }
    if (typeof entry.path !== "string" || entry.path.trim() === "" || isAbsolute(entry.path)) {
      fail(`Manifest entry ${index + 1} has an invalid relative desktop path`);
    }
    if (entry.path.split(/[\\/]/).some((part) => part === ".." || part === "")) {
      fail(`Manifest entry ${index + 1} has an unsafe desktop path: ${entry.path}`);
    }
    if (!Array.isArray(entry.consumers) || entry.consumers.length === 0) {
      fail(`Manifest entry ${index + 1} must list at least one consumer`);
    }
    for (const [consumerIndex, consumer] of entry.consumers.entries()) {
      if (consumer === null || typeof consumer !== "object" || Array.isArray(consumer)) {
        fail(`Manifest entry ${index + 1} consumer ${consumerIndex + 1} must be an object`);
      }
      const actualConsumerKeys = Object.keys(consumer).sort();
      if (JSON.stringify(actualConsumerKeys) !== JSON.stringify(consumerKeys)) {
        fail(`Manifest entry ${index + 1} consumer ${consumerIndex + 1} must contain only repo and file`);
      }
      if (typeof consumer.repo !== "string" || consumer.repo.trim() === "" ||
          typeof consumer.file !== "string" || consumer.file.trim() === "") {
        fail(`Manifest entry ${index + 1} consumer ${consumerIndex + 1} needs non-empty repo and file fields`);
      }
    }
    if (!Array.isArray(entry.required_tokens) ||
        entry.required_tokens.some((token) => typeof token !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(token))) {
      fail(`Manifest entry ${index + 1} required_tokens must be uppercase declaration names`);
    }
  }
}

function consumerNames(consumers) {
  return consumers.map(({ repo, file }) => `${repo} ${file}`).join(", ");
}

function hasConstDeclaration(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    `^[\\t ]*(?:pub(?:\\([^)]*\\))?[\\t ]+)?const[\\t ]+${escapedName}\\b[\\t ]*(?::[^=\\r\\n]+)?=`,
    "m",
  );
  return declaration.test(source);
}

export function checkCrossRepoConsumers({ repoRoot = defaultRoot, manifestPath } = {}) {
  const resolvedRoot = resolve(repoRoot);
  const resolvedManifest = resolve(manifestPath ?? resolve(resolvedRoot, ".github/cross-repo-consumers.json"));
  const manifest = JSON.parse(readFileSync(resolvedManifest, "utf8"));
  validateManifest(manifest);

  const failures = [];
  for (const entry of manifest) {
    const desktopPath = resolve(resolvedRoot, entry.path);
    const relativePath = relative(resolvedRoot, desktopPath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      fail(`Manifest desktop path escapes the repository root: ${entry.path}`);
    }

    const consumers = consumerNames(entry.consumers);
    if (!existsSync(desktopPath) || !statSync(desktopPath).isFile()) {
      failures.push(
        `Desktop path "${entry.path}" is missing for consumer ${consumers}. ` +
        "Restore the file or update this manifest after each listed consumer has moved.",
      );
      continue;
    }

    const source = readFileSync(desktopPath, "utf8");
    for (const token of entry.required_tokens) {
      if (!hasConstDeclaration(source, token)) {
        failures.push(
          `Desktop path "${entry.path}" required by consumer ${consumers} ` +
          `is missing declaration "${token}". Restore the declaration or update the consumer and manifest together.`,
        );
      }
    }
  }

  if (failures.length > 0) {
    fail(`Cross-repo consumer check failed:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  }
  return manifest;
}

function run() {
  try {
    const entries = checkCrossRepoConsumers();
    console.log(`Cross-repo consumer check passed: ${entries.length} entries checked.`);
    for (const entry of entries) {
      const declarations = entry.required_tokens.length > 0 ? entry.required_tokens.join(", ") : "none";
      console.log(`- ${entry.path} -> ${consumerNames(entry.consumers)}; declarations: ${declarations}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run();
}
