import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  archiveNameForRelease,
  assertPublishableNativeBundle,
  channelsReceivingRelease,
  classifyNativeReleaseTag,
  createLegacyLatestManifest,
  parseSparkleSigningOutput,
  renderSparkleAppcast,
  sparklePublicKeyFromPrivateSeed,
  type NativeReleaseChannel,
  type PublishableNativeBundle,
} from "./native-macos-release";
import { inspectNativeReleaseBundle } from "./verify-native-macos-release";

export type NativeReleaseProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
};

export type NativeReleaseProcessRunner = (
  command: string,
  args: string[],
  options?: NativeReleaseProcessOptions,
) => Promise<{ stdout: string; stderr: string }>;

export type PrepareNativeReleaseInput = {
  appPath: string;
  outputDirectory: string;
  tag: string;
  repository: string;
  publicationDate: Date;
  sparklePrivateKey: string;
  sparkleSignUpdateBinary: string;
  tauriSigningPrivateKey: string;
  tauriSigningPrivateKeyPassword?: string;
};

export type PrepareNativeReleaseDependencies = {
  inspectBundle?: (appPath: string) => Promise<PublishableNativeBundle>;
  runProcess?: NativeReleaseProcessRunner;
};

export type PreparedNativeRelease = {
  archiveName: string;
  channels: NativeReleaseChannel[];
  latestManifestPath: string;
  appcastPaths: Record<NativeReleaseChannel, string | undefined>;
  publishingEnabled: false;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function prepareNativeMacOSRelease(
  input: PrepareNativeReleaseInput,
  dependencies: PrepareNativeReleaseDependencies = {},
): Promise<PreparedNativeRelease> {
  const inspectBundle = dependencies.inspectBundle
    ?? inspectNativeReleaseBundle;
  const runProcess = dependencies.runProcess ?? defaultProcessRunner;
  const release = classifyNativeReleaseTag(input.tag);
  validateRepository(input.repository);
  assertSigningInputs(input);

  const bundle = await inspectBundle(input.appPath);
  assertPublishableNativeBundle(bundle);
  const signingPublicKey = sparklePublicKeyFromPrivateSeed(
    input.sparklePrivateKey,
  );
  if (signingPublicKey !== bundle.publicKey) {
    throw new Error(
      "The Sparkle private key does not match the public key embedded in HQ.app",
    );
  }
  if (release.version !== bundle.shortVersion) {
    throw new Error(
      `Release tag ${release.version} does not match bundle version ${bundle.shortVersion}`,
    );
  }

  const outputDirectory = resolve(input.outputDirectory);
  const archiveName = archiveNameForRelease(release.version);
  const archivePath = join(outputDirectory, archiveName);
  const legacySignaturePath = `${archivePath}.sig`;
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    rm(archivePath, { force: true }),
    rm(legacySignaturePath, { force: true }),
  ]);

  const appPath = resolve(input.appPath);
  await runProcess(
    "/usr/bin/tar",
    ["-C", dirname(appPath), "-czf", archivePath, "HQ.app"],
  );
  const archiveStats = await stat(archivePath);
  if (!archiveStats.isFile() || archiveStats.size < 1) {
    throw new Error("Native update archive is empty or missing");
  }

  await runProcess(
    "pnpm",
    [
      "--dir",
      join(repoRoot, "apps/sync"),
      "tauri",
      "signer",
      "sign",
      archivePath,
    ],
    {
      cwd: repoRoot,
      env: {
        TAURI_SIGNING_PRIVATE_KEY: input.tauriSigningPrivateKey,
        ...(input.tauriSigningPrivateKeyPassword
          ? {
              TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
                input.tauriSigningPrivateKeyPassword,
            }
          : {}),
      },
    },
  );
  const legacySignature = (await readFile(
    legacySignaturePath,
    "utf8",
  )).trim();
  if (!legacySignature) {
    throw new Error("Tauri signer did not produce a legacy minisign signature");
  }

  const sparkleSigningResult = await runProcess(
    input.sparkleSignUpdateBinary,
    ["--ed-key-file", "-", archivePath],
    { stdin: input.sparklePrivateKey },
  );
  const sparkleSigning = parseSparkleSigningOutput(
    sparkleSigningResult.stdout,
  );
  if (sparkleSigning.length !== archiveStats.size) {
    throw new Error(
      "Sparkle signature length does not match the shared update archive",
    );
  }

  const encodedRepository = input.repository
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const encodedTag = encodeURIComponent(release.tag);
  const encodedArchiveName = encodeURIComponent(archiveName);
  const releaseBaseURL =
    `https://github.com/${encodedRepository}/releases/download/${encodedTag}`;
  const archiveURL = `${releaseBaseURL}/${encodedArchiveName}`;
  const notesURL =
    `https://github.com/${encodedRepository}/releases/tag/${encodedTag}`;
  const latestManifest = createLegacyLatestManifest({
    tag: release.tag,
    archiveURL,
    legacySignature,
    publicationDate: input.publicationDate,
    notesURL,
  });
  const latestManifestPath = join(outputDirectory, "latest.json");
  await writeFile(
    latestManifestPath,
    `${JSON.stringify(latestManifest, null, 2)}\n`,
  );

  const channels = channelsReceivingRelease(release.channel);
  const appcastPaths: Record<NativeReleaseChannel, string | undefined> = {
    stable: undefined,
    beta: undefined,
    alpha: undefined,
  };
  for (const channel of channels) {
    const appcastPath = join(
      outputDirectory,
      "feeds",
      channel,
      "appcast.xml",
    );
    await mkdir(dirname(appcastPath), { recursive: true });
    await writeFile(
      appcastPath,
      renderSparkleAppcast({
        channel,
        release,
        repository: input.repository,
        buildVersion: bundle.buildVersion,
        archiveURL,
        archiveLength: archiveStats.size,
        sparkleSignature: sparkleSigning.signature,
        publicationDate: input.publicationDate,
        releaseNotesURL: notesURL,
      }),
    );
    appcastPaths[channel] = appcastPath;
  }

  const result: PreparedNativeRelease = {
    archiveName,
    channels,
    latestManifestPath,
    appcastPaths,
    publishingEnabled: false,
  };
  await writeFile(
    join(outputDirectory, "native-release-plan.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

export function releaseInputsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PrepareNativeReleaseInput {
  const appPath = environment.HQ_NATIVE_APP_PATH;
  const outputDirectory = environment.HQ_RELEASE_OUTPUT_DIR;
  const tag = environment.HQ_RELEASE_TAG;
  const repository = environment.HQ_RELEASE_REPOSITORY;
  if (!appPath || !outputDirectory || !tag || !repository) {
    throw new Error(
      "HQ_NATIVE_APP_PATH, HQ_RELEASE_OUTPUT_DIR, HQ_RELEASE_TAG, and HQ_RELEASE_REPOSITORY are required",
    );
  }

  const sparklePrivateKey = environment.SPARKLE_ED_PRIVATE_KEY;
  const sparkleSignUpdateBinary = environment.SPARKLE_SIGN_UPDATE_BIN;
  const tauriSigningPrivateKey = environment.TAURI_SIGNING_PRIVATE_KEY;
  if (!sparklePrivateKey
      || !sparkleSignUpdateBinary
      || !tauriSigningPrivateKey) {
    throw new Error(
      "SPARKLE_ED_PRIVATE_KEY, SPARKLE_SIGN_UPDATE_BIN, and TAURI_SIGNING_PRIVATE_KEY are required",
    );
  }

  const sourceDate = environment.SOURCE_DATE_EPOCH;
  const publicationDate = sourceDate
    ? new Date(Number(sourceDate) * 1_000)
    : new Date();
  if (Number.isNaN(publicationDate.valueOf())) {
    throw new Error("SOURCE_DATE_EPOCH must be Unix epoch seconds");
  }

  return {
    appPath,
    outputDirectory,
    tag,
    repository,
    publicationDate,
    sparklePrivateKey,
    sparkleSignUpdateBinary,
    tauriSigningPrivateKey,
    tauriSigningPrivateKeyPassword:
      environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  };
}

export async function main(): Promise<number> {
  const result = await prepareNativeMacOSRelease(
    releaseInputsFromEnvironment(),
  );
  console.log(
    `Prepared ${result.archiveName}, latest.json, and ${result.channels.join(", ")} appcast feed(s). Publishing remains disabled.`,
  );
  return 0;
}

async function defaultProcessRunner(
  command: string,
  args: string[],
  options: NativeReleaseProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (status) => {
      if (status === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(
          new Error(
            `${command} exited with status ${status ?? "unknown"}: ${stderr.trim()}`,
          ),
        );
      }
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function validateRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Release repository must use owner/name format");
  }
}

function assertSigningInputs(input: PrepareNativeReleaseInput): void {
  if (!input.sparklePrivateKey
      || !input.sparkleSignUpdateBinary
      || !input.tauriSigningPrivateKey) {
    throw new Error("All legacy and Sparkle signing inputs are required");
  }
}

function isCliEntrypoint(metaURL: string): boolean {
  return process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(metaURL);
}

if (isCliEntrypoint(import.meta.url)) {
  main().then((status) => {
    process.exitCode = status;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
