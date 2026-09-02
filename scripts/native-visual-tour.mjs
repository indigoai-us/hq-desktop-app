#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultOutput = join(
  repositoryRoot,
  "apps/native-macos/VisualTour/Artifacts",
);

const options = {
  output: defaultOutput,
  derivedData: "/tmp/hq-native-visual-tour",
  variant: undefined,
  surface: undefined,
  verifyOnly: false,
};

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--verify-only") {
    options.verifyOnly = true;
  } else if (argument === "--output") {
    options.output = resolve(requiredValue(argument, ++index));
  } else if (argument === "--derived-data") {
    options.derivedData = resolve(requiredValue(argument, ++index));
  } else if (argument === "--variant") {
    options.variant = requiredValue(argument, ++index);
  } else if (argument === "--surface") {
    options.surface = requiredValue(argument, ++index);
  } else {
    fail(`Unknown argument: ${argument}`);
  }
}

const allowedVariants = new Set([
  "light",
  "dark",
  "light-reduced",
  "dark-reduced",
]);
if (options.variant && !allowedVariants.has(options.variant)) {
  fail(`Unknown visual-tour variant: ${options.variant}`);
}

if (!options.verifyOnly) {
  const runnerContainerTemporaryDirectory = join(
    homedir(),
    "Library/Containers/ai.indigo.hq.native.uitests.xctrunner/Data/tmp",
  );
  mkdirSync(runnerContainerTemporaryDirectory, { recursive: true });
  const stagedOutput = mkdtempSync(
    join(runnerContainerTemporaryDirectory, "hq-native-visual-tour-"),
  );

  run("xcodegen", [
    "generate",
    "--spec",
    "apps/native-macos/project.yml",
    "--project",
    "apps/native-macos",
  ]);
  run("xcodebuild", [
    "-quiet",
    "-project",
    "apps/native-macos/HQNative.xcodeproj",
    "-scheme",
    "HQNative",
    "-configuration",
    "Debug",
    "-destination",
    "platform=macOS",
    "-derivedDataPath",
    options.derivedData,
    "ENABLE_HARDENED_RUNTIME=NO",
    "build-for-testing",
  ]);

  const xctestrunPath = resolveTestRunFile(options.derivedData);
  const testEnvironment =
    "HQNativeUITests.EnvironmentVariables";
  setPlistString(
    xctestrunPath,
    `${testEnvironment}.HQ_VISUAL_TOUR_OUTPUT_DIR`,
    stagedOutput,
  );
  removePlistValue(
    xctestrunPath,
    `${testEnvironment}.HQ_VISUAL_TOUR_VARIANT`,
  );
  removePlistValue(
    xctestrunPath,
    `${testEnvironment}.HQ_VISUAL_TOUR_SURFACE`,
  );
  if (options.variant) {
    setPlistString(
      xctestrunPath,
      `${testEnvironment}.HQ_VISUAL_TOUR_VARIANT`,
      options.variant,
    );
  }
  if (options.surface) {
    setPlistString(
      xctestrunPath,
      `${testEnvironment}.HQ_VISUAL_TOUR_SURFACE`,
      options.surface,
    );
  }
  run(
    "xcodebuild",
    [
      "-quiet",
      "-xctestrun",
      xctestrunPath,
      "-destination",
      "platform=macOS",
      "test-without-building",
      "-only-testing:HQNativeUITests/HQNativeVisualTourUITests/testCaptureExhaustiveVisualTour",
    ],
  );
  exportVisualTourArtifacts(stagedOutput, options.output);
  rmSync(stagedOutput, { recursive: true, force: true });
}

const isFiltered = Boolean(options.variant || options.surface);
const manifestPath = join(
  options.output,
  isFiltered ? "manifest-filtered.json" : "manifest.json",
);
if (!existsSync(manifestPath)) {
  fail(`Visual-tour manifest does not exist: ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const expectedFullCaptureCount = 4 * (30 + 17);
if (manifest.expectedRouteCount !== 30) {
  fail(`Expected 30 routes, received ${manifest.expectedRouteCount}`);
}
if (manifest.expectedWindowCount !== 17) {
  fail(`Expected 17 windows, received ${manifest.expectedWindowCount}`);
}
if (!isFiltered && manifest.expectedCaptureCount !== expectedFullCaptureCount) {
  fail(
    `Expected a 188-state manifest, received ${manifest.expectedCaptureCount}`,
  );
}
if (manifest.actualCaptureCount !== manifest.expectedCaptureCount) {
  fail(
    `Capture count mismatch: ${manifest.actualCaptureCount}/` +
      `${manifest.expectedCaptureCount}`,
  );
}
if (!manifest.complete) {
  const failures = manifest.captures
    .filter((capture) => !capture.passed)
    .map(
      (capture) =>
        `${capture.variant} ${capture.kind} ${capture.parityID}: ` +
        capture.failures.join("; "),
    );
  fail(`Visual-tour verification failed:\n${failures.join("\n")}`);
}

for (const capture of manifest.captures) {
  const artifactPath = join(options.output, capture.artifact);
  if (!existsSync(artifactPath)) {
    fail(`Manifest artifact is missing: ${artifactPath}`);
  }
  const bytes = readFileSync(artifactPath);
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes.toString("ascii", 1, 4) !== "PNG"
  ) {
    fail(`Manifest artifact is not a PNG: ${artifactPath}`);
  }
  if (!capture.metrics || capture.metrics.byteCount !== bytes.length) {
    fail(`Manifest metrics disagree with artifact: ${artifactPath}`);
  }
}

console.log(
  `Native visual tour verified ${manifest.actualCaptureCount} full-window ` +
    `captures (${manifest.expectedRouteCount} routes + ` +
    `${manifest.expectedWindowCount} windows across ` +
    `${isFiltered ? "the requested filter" : "4 variants"}).`,
);
console.log(manifestPath);

function requiredValue(flag, index) {
  const value = process.argv[index];
  if (!value || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function resolveTestRunFile(derivedData) {
  const products = join(derivedData, "Build/Products");
  const candidates = readdirSync(products)
    .filter((name) => name.endsWith(".xctestrun"))
    .sort();
  if (candidates.length !== 1) {
    fail(
      `Expected one generated .xctestrun file in ${products}, ` +
        `received ${candidates.length}`,
    );
  }
  return join(products, candidates[0]);
}

function exportVisualTourArtifacts(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(destination, entry), {
      recursive: true,
      force: true,
    });
  }
}

function setPlistString(plistPath, keyPath, value) {
  const replace = spawnSync(
    "/usr/bin/plutil",
    ["-replace", keyPath, "-string", value, plistPath],
    {
      cwd: repositoryRoot,
      stdio: "pipe",
    },
  );
  if (!replace.error && replace.status === 0) {
    return;
  }
  run("/usr/bin/plutil", [
    "-insert",
    keyPath,
    "-string",
    value,
    plistPath,
  ]);
}

function removePlistValue(plistPath, keyPath) {
  spawnSync("/usr/bin/plutil", ["-remove", keyPath, plistPath], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
}

function run(command, arguments_, environment = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`${command} failed to launch: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
