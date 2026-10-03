/**
 * Owner decision: bot creation is one shared three-step modal from the
 * Messages "New" menu. Settings › Bots "New bot" opens that same modal (the
 * host closes Settings first) and creating lands in the bot's DM. Settings
 * keeps no cloud create path of its own, so every cloud create goes through
 * the Messages path and its per-company flag check.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

describe("Settings › Bots New bot uses the shared Messages modal", () => {
  const shell = read("../shell/DesktopApp.svelte");
  const pane = read("BotsSettingsPane.svelte");
  const settings = read("ShellSettings.svelte");

  it("the shell hands Settings a New bot opener that closes Settings and opens the Messages modal", () => {
    expect(shell).toMatch(/onnewbot=\{openNewBotFromSettings\}/);
    const fn = shell.slice(shell.indexOf("function openNewBotFromSettings"));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    expect(body).toContain("closeSettings()");
    expect(body).toMatch(/actions\.openNewAgent\(/);
  });

  it("Settings passes the opener to the Bots pane", () => {
    expect(settings).toMatch(/<BotsSettingsPane[^>]*\{onnewbot\}/);
  });

  it("every direct cloud create reads the flag for the chosen company", () => {
    const fn = shell.slice(shell.indexOf("async function createCloudBotDirect"));
    const body = fn.slice(0, fn.indexOf("\n  }\n"));
    expect(body).toContain("runCompanyDirectCloudCreate(");
    expect(shell).not.toMatch(/\brunDirectCloudCreate\(/);
  });

  it("Settings has no cloud create of its own", () => {
    expect(shell).not.toMatch(/oncreatecloudbot=/);
    expect(pane).not.toMatch(/onCloudCreate=\{(?!null)/);
    expect(pane).not.toMatch(/directCloud/);
  });
});
