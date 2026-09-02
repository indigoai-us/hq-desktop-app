#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const parity = join(repo, "apps/native-macos/Parity");
const failures = [];

const read = (name) =>
  JSON.parse(readFileSync(join(parity, name), "utf8"));

const commands = read("commands.json");
const events = read("events.json");
const retainedContracts = read("retained-contracts.json");
const routes = read("routes.json").routes;
const windows = read("windows.json").windows;

const allowedCommandDispositions = new Set([
  "engine",
  "native",
  "retired",
  "windows-only",
]);
const allowedEventDispositions = new Set(["engine", "native", "retired"]);

if (commands.commands.length !== commands.registeredCount) {
  failures.push(
    `commands.json count mismatch: ${commands.commands.length} rows for ${commands.registeredCount} registered commands`,
  );
}
if (commands.frontendOnlyCommands.length > 0) {
  failures.push(
    `frontend-only commands: ${commands.frontendOnlyCommands.map((row) => row.name).join(", ")}`,
  );
}
for (const command of commands.commands) {
  if (!allowedCommandDispositions.has(command.disposition)) {
    failures.push(
      `command ${command.name} has unsupported disposition ${command.disposition}`,
    );
  }
}
for (const retained of retainedContracts.commands) {
  const generated = commands.commands.find(
    (command) => command.name === retained.name,
  );
  if (!generated) {
    failures.push(`commands.json dropped retained command ${retained.name}`);
  } else if (
    generated.symbol !== retained.symbol ||
    generated.disposition !== retained.disposition
  ) {
    failures.push(
      `command ${retained.name} no longer matches its retained contract`,
    );
  }
}

if (events.events.length !== events.listenerCount) {
  failures.push(
    `events.json count mismatch: ${events.events.length} rows for ${events.listenerCount} listeners`,
  );
}
for (const event of events.events) {
  if (!allowedEventDispositions.has(event.disposition)) {
    failures.push(
      `event ${event.name} has unsupported disposition ${event.disposition}`,
    );
  }
  if (
    ["native", "retired"].includes(event.disposition) &&
    !event.nativeReplacement?.trim()
  ) {
    failures.push(
      `event ${event.name} needs explicit native/retired replacement evidence`,
    );
  }
}
for (const retained of retainedContracts.events) {
  const generated = events.events.find((event) => event.name === retained.name);
  if (!generated) {
    failures.push(`events.json dropped retained event ${retained.name}`);
  } else if (generated.disposition !== retained.disposition) {
    failures.push(
      `event ${retained.name} no longer matches its retained contract`,
    );
  }
}

for (const [name, rows] of [
  ["route", routes],
  ["window", windows],
]) {
  const ids = new Set();
  for (const row of rows) {
    if (!row.id) failures.push(`${name} row is missing an id`);
    if (ids.has(row.id)) failures.push(`duplicate ${name} id ${row.id}`);
    ids.add(row.id);
    if (row.owner !== "native") {
      failures.push(`${name} ${row.id} is not owned by native macOS`);
    }
    if (row.visualRequired !== true) {
      failures.push(`${name} ${row.id} is missing visual verification`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Native parity gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      commands: commands.registeredCount,
      events: events.listenerCount,
      routes: routes.length,
      windows: windows.length,
      status: "mapped",
    })}\n`,
  );
}
