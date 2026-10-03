/**
 * Guard: every visible company name goes through `CompanyLabel` (icon + name).
 *
 * The scanner reads each `.svelte` file under `src`, blanks out `<script>`,
 * `<style>`, and HTML comments, and walks the template. A `{...}` expression
 * that sits in a text node (not inside a tag, so not an attribute or a prop)
 * and reads a company name is a bare company-name render. Passing the name to
 * `<CompanyLabel name={...}>` is a prop, so it never trips the guard.
 *
 * The allowlist is only for plain-text contexts where an icon makes no sense:
 * sentences of prose, message bodies, logs, and similar. Each entry is keyed by
 * file plus the exact expression text, so it survives line drift.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

/** `file::expression` → why the bare text is fine there. */
const ALLOWLIST: Record<string, string> = {
  "agency/AgencyQuestionsPanel.svelte::q.company":
    "`company/team` path identifier, not a company label.",
  "agency/AgencyTeamsPanel.svelte::pendingFor(t.company, t.team)":
    "Renders a waiting count; the company is only an argument.",
  "atlas/AtlasView.svelte::companyTitle":
    "Sentence: \"{name} is empty\".",
  "chat/AgencyChatPanel.svelte::selected.company":
    "`company/team` path identifier, not a company label.",
  "chat/CreateModal.svelte::blocked ? `${company.label} \u2014 ${blocked.reason}` : company.label":
    "Native <option> text cannot hold markup.",
  "chat/LocalBotDetailPanel.svelte::company.name":
    "Native <option> text cannot hold markup.",
  "chat/SetupFinale.svelte::company.label":
    "Button verb phrase (\"Open {name}\"), not a bare name.",
  "chat/SetupRunCard.svelte::card.scope === \"company\" ? (card.company ? `${card.company} vault` : \"company vault\") : \"your personal vault\"":
    "Sentence fragment: \"{name} vault\".",
  "chat/create-bot/CloudDetailsStep.svelte::nameError ?? `What ${companyLabel} will call it.`":
    "Help sentence.",
  "chat/create-bot/CloudDetailsStep.svelte::handleError ?? `People @mention it as @${handle} in ${companyLabel}'s channels.`":
    "Help sentence.",
  "chat/create-bot/CloudDetailsStep.svelte::companyLabel":
    "Help sentence: \"{name} hosts it and opens its channel.\"",
  "meetings/MeetingsSidepane.svelte::row.companyLabel ?? \"\"":
    "Screen-reader text inside the row's company mark; nothing visible.",
  "common/LiveNowCard.svelte::humanCompanyLabel(m)":
    "Native <option> text cannot hold markup.",
  "company/CompanySettingsPage.svelte::snap.general.name || companyLabel":
    "Sentence: \"billed to {name}\".",
  "files/explorer/ShareFileSheet.svelte::target.company":
    "Sentence fragment: \"{name} vault\".",
  "library/LibraryDetailPanel.svelte::item.worker.scope === \"company\" ? (item.worker.company ?? \"company\") : \"shared\"":
    "Scope badge text that mixes company with other scopes.",
  "library/LibraryDetailPanel.svelte::item.skill.scope === \"company\" ? (item.skill.company ?? \"company\") : item.skill.scope":
    "Scope badge text that mixes company with other scopes.",
  "library/PersonalLibraryPage.svelte::grant.company":
    "Sentence fragment: \"{owner} \u00b7 {company}\" in an access summary.",
  "meet/OfficePanel.svelte::companyLabel":
    "Sentence: \"{name} is not connected to HQ cloud\".",
  "meetings/MeetingsStatesBody.svelte::companyName":
    "Sentence: \"Join opens 10 min before \u00b7 {name}\".",
  "settings/PrototypeSettingsPanes.svelte::row.name":
    "Native <option> text cannot hold markup.",
  "settings/SettingsPage.svelte::m.companyName?.trim() || \"Company\"":
    "Native <option> text cannot hold markup.",
  "shell/AtlasLandingHost.svelte::companyLabel":
    "Loading status sentence: \"Loading {name}\".",
};

/**
 * Direct company-name reads: `company.name`, `companyLabel`, `row.companyName`,
 * a `row.company` string field, or a bare `{company}`.
 */
const COMPANY_NAME = new RegExp(
  [
    String.raw`\b\w*[cC]ompany\w*\??\.(?:name|label|displayName|title)\b`,
    String.raw`\b\w*[cC]ompany(?:Name|Label|DisplayName|Title)\b`,
    String.raw`\b\w+\??\.(?:shared)?[cC]ompany\b(?!\s*[\w.(\[])`,
    String.raw`^company$`,
  ].join("|"),
);

/** True when an `#each` iterable is a list of companies, judged by its last name. */
function isCompanyList(iterable: string): boolean {
  const names = iterable.replace(/\([^)]*\)/g, "").match(/\w+/g) ?? [];
  const last = names[names.length - 1] ?? "";
  return /(?:compan(?:y|ies)|companyRows|workspaces|memberships|agentTargets)$/i.test(last);
}

function readsAlias(expr: string, stack: (string | null)[]): boolean {
  return stack.some(
    (alias) =>
      alias !== null &&
      new RegExp(`\\b${alias}\\??\\.(?:name|label|displayName|title)\\b`).test(expr),
  );
}

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      svelteFiles(full, out);
    } else if (entry.endsWith(".svelte") && !entry.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

/** Replace a region with spaces but keep newlines so line numbers stay right. */
function blank(text: string, re: RegExp): string {
  return text.replace(re, (m) => m.replace(/[^\n]/g, " "));
}

export interface BareCompanyName {
  file: string;
  line: number;
  expr: string;
}

export function scanTemplate(file: string, source: string): BareCompanyName[] {
  let t = blank(source, /<script\b[\s\S]*?<\/script>/g);
  t = blank(t, /<style\b[\s\S]*?<\/style>/g);
  t = blank(t, /<!--[\s\S]*?-->/g);

  const hits: BareCompanyName[] = [];
  // `{#each companies as c}` loops: inside the block, `{c.label}` is a
  // company name too.
  const eachStack: (string | null)[] = [];
  let inTag = false;
  let quote: string | null = null;
  let line = 1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === "\n") line++;
    if (inTag) {
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "{") {
        // Attribute or prop expression: skip it whole.
        let depth = 1;
        while (depth > 0 && ++i < t.length) {
          if (t[i] === "{") depth++;
          else if (t[i] === "}") depth--;
          else if (t[i] === "\n") line++;
        }
      } else if (ch === ">") {
        inTag = false;
      }
      continue;
    }
    if (ch === "<" && /[A-Za-z/]/.test(t[i + 1] ?? "")) {
      inTag = true;
      continue;
    }
    if (ch === "{") {
      const startLine = line;
      let depth = 1;
      let j = i;
      while (depth > 0 && ++j < t.length) {
        if (t[j] === "{") depth++;
        else if (t[j] === "}") depth--;
        else if (t[j] === "\n") line++;
      }
      const expr = t.slice(i + 1, j).trim();
      i = j;
      const each = /^#each\s+([\s\S]*?)\s+as\s+(\w+)/.exec(expr);
      if (each) {
        eachStack.push(isCompanyList(each[1]!) ? each[2]! : null);
        continue;
      }
      if (/^\/each\b/.test(expr)) {
        eachStack.pop();
        continue;
      }
      if (/^[#/:@]/.test(expr)) continue;
      if (COMPANY_NAME.test(expr) || readsAlias(expr, eachStack)) {
        hits.push({ file, line: startLine, expr: expr.replace(/\s+/g, " ") });
      }
    }
  }
  return hits;
}

describe("company names render through CompanyLabel", () => {
  const files = svelteFiles(SRC);
  const hits = files.flatMap((full) =>
    scanTemplate(relative(SRC, full), readFileSync(full, "utf8")),
  );

  it("has no bare company-name text outside the allowlist", () => {
    const offenders = hits
      .filter((h) => !(`${h.file}::${h.expr}` in ALLOWLIST))
      .map((h) => `${h.file}:${h.line}  {${h.expr}}`);
    expect(offenders, "Render these with <CompanyLabel>, or allowlist a plain-text context").toEqual([]);
  });

  it("keeps every allowlist entry live", () => {
    const seen = new Set(hits.map((h) => `${h.file}::${h.expr}`));
    expect(Object.keys(ALLOWLIST).filter((k) => !seen.has(k))).toEqual([]);
  });

  it("flags a bare name but not a prop, attribute, or CompanyLabel", () => {
    const src = [
      "<script>let company = { name: 'A' };</script>",
      "<span>{company.name}</span>",
      "<span title={company.name}>x</span>",
      "<CompanyLabel name={company.name} />",
      "{#each companies as c}<b>{c.label}</b>{/each}",
    ].join("\n");
    expect(scanTemplate("x.svelte", src).map((h) => [h.line, h.expr])).toEqual([
      [2, "company.name"],
      [5, "c.label"],
    ]);
  });
});
