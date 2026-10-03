/**
 * OWNER-R12: the worker pane's details, read from the worker's own
 * worker.yaml through the app's existing local file read.
 *
 * worker.yaml uses a small YAML subset (maps, lists, block text, quoted
 * scalars, trailing comments). `parseWorkerYaml` reads that subset; anything
 * it cannot read is left out rather than guessed. Pure: no Svelte, no Tauri.
 */

export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue };
type YamlMap = { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s:[,-]/.test(text[i - 1] ?? "")) quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1] ?? ""))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function scalar(raw: string): YamlValue {
  const t = raw.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
    return t.slice(1, -1);
  }
  const flow = t.match(/^\[(.*)\]$/);
  if (flow) {
    return flow[1]!
      .split(",")
      .map((part) => scalar(part))
      .filter((v): v is string => typeof v === "string" && v !== "");
  }
  return t;
}

/** Parse the worker.yaml subset into plain values. Never throws. */
export function parseWorkerYaml(source: string): YamlMap {
  const raw = source.replace(/\r/g, "").split("\n");
  let i = 0;

  function next(): Line | null {
    while (i < raw.length) {
      const line = raw[i]!;
      const text = stripComment(line);
      if (text.trim() === "" || text.trim() === "---") {
        i++;
        continue;
      }
      return { indent: line.length - line.trimStart().length, text: text.trim() };
    }
    return null;
  }

  function blockText(parentIndent: number, folded: boolean): string {
    const out: string[] = [];
    let base = -1;
    while (i < raw.length) {
      const line = raw[i]!;
      if (line.trim() === "") {
        out.push("");
        i++;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= parentIndent) break;
      if (base < 0) base = indent;
      out.push(line.slice(Math.min(base, indent)));
      i++;
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return folded ? out.join(" ").replace(/\s+/g, " ").trim() : out.join("\n");
  }

  function value(rest: string, indent: number): YamlValue {
    const r = rest.trim();
    if (r === "|" || r === "|-" || r === "|+") return blockText(indent, false);
    if (r === ">" || r === ">-" || r === ">+") return blockText(indent, true);
    if (r !== "") return scalar(r);
    const peek = next();
    if (!peek || peek.indent < indent) return null;
    if (peek.indent === indent && !peek.text.startsWith("- ") && peek.text !== "-") return null;
    return block(peek.indent);
  }

  function block(indent: number): YamlValue {
    const first = next();
    if (!first) return null;
    if (first.text.startsWith("- ") || first.text === "-") return list(indent);
    return map(indent);
  }

  function map(indent: number, into: YamlMap = {}): YamlMap {
    for (;;) {
      const line = next();
      if (!line || line.indent < indent || line.indent > indent) return into;
      if (line.text.startsWith("- ")) return into;
      const kv = line.text.match(/^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*)|$)/);
      i++;
      if (!kv) continue;
      const key = String(scalar(kv[1]!) ?? "");
      into[key] = value(kv[2] ?? "", indent);
    }
  }

  function list(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      const line = next();
      if (!line || line.indent !== indent || !(line.text.startsWith("- ") || line.text === "-")) return out;
      const rest = line.text === "-" ? "" : line.text.slice(2);
      const kv = rest.match(/^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*)|$)/);
      i++;
      if (kv) {
        // A map item: its first key sits on the dash line, the rest two deeper.
        const itemIndent = indent + 2;
        const item: YamlMap = {};
        item[kv[1]!] = value(kv[2] ?? "", itemIndent);
        const more = next();
        if (more && more.indent > indent && !more.text.startsWith("- ")) map(more.indent, item);
        out.push(item);
      } else if (rest.trim() === "") {
        const peek = next();
        out.push(peek && peek.indent > indent ? block(peek.indent) : null);
      } else {
        out.push(scalar(rest));
      }
    }
  }

  const top = next();
  if (!top) return {};
  const parsed = map(top.indent);
  return parsed;
}

const asMap = (v: YamlValue | undefined): YamlMap =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
const asList = (v: YamlValue | undefined): YamlValue[] => (Array.isArray(v) ? v : []);
function asText(v: YamlValue | undefined): string {
  if (typeof v !== "string") return "";
  return v.trim();
}

export interface WorkerDetailRow {
  label: string;
  value: string;
}

export interface WorkerSkillEntry {
  name: string;
  description: string;
  /** HQ-relative file for the skill, when one is declared or found. */
  file: string | null;
}

export interface WorkerYamlDetail {
  status: string;
  rows: WorkerDetailRow[];
  /** "Asks before: …" lines, from human checkpoints and approval rules. */
  asksBefore: string[];
  contextFiles: string[];
  knowledgeFiles: string[];
  skills: WorkerSkillEntry[];
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line;
}

function fileList(v: YamlValue | undefined): string[] {
  return asList(v)
    .map((item) => (typeof item === "string" ? item : asText(asMap(item).path) || asText(asMap(item).pattern)))
    .map((s) => s.trim())
    .filter(Boolean);
}

function lowerFirst(text: string): string {
  return text ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** Details from worker.yaml. Only fields that have a value become rows. */
export function workerYamlDetail(source: string, workerDir: string): WorkerYamlDetail {
  const doc = parseWorkerYaml(source);
  const worker = asMap(doc.worker);
  const execution = asMap(doc.execution);
  const verification = asMap(doc.verification);
  const rows: WorkerDetailRow[] = [];
  const add = (label: string, v: YamlValue | undefined) => {
    const text = asText(v);
    if (text) rows.push({ label, value: text });
  };
  add("Type", worker.type ?? doc.type);
  add("Team", worker.team ?? doc.team);
  add("Model", execution.model ?? worker.model ?? doc.model);
  add("Runtime", execution.runtime ?? doc.runtime);
  add("Mode", execution.mode);
  add("Schedule", execution.schedule ?? doc.schedule);
  add("Time zone", asText(execution.schedule ?? doc.schedule) ? execution.timezone : undefined);
  add("Max runtime", execution.max_runtime ?? doc.max_runtime);

  const approval = verification.approval_required ?? doc.approval_required ?? execution.approval_required;
  if (asText(approval) === "true") rows.push({ label: "Approval", value: "Required before it finishes" });

  const checkpoints = asList(doc.human_checkpoints ?? execution.human_checkpoints ?? verification.human_checkpoints);
  const asksBefore = checkpoints
    .map((item) => {
      if (typeof item === "string") return item.trim() ? `Asks before: ${lowerFirst(item.trim())}` : "";
      const m = asMap(item);
      if (asText(m.when)) return `Asks for approval ${lowerFirst(asText(m.when))}`;
      const other = asText(m.rule) || asText(m.id);
      return other ? `Asks before: ${lowerFirst(other)}` : "";
    })
    .filter(Boolean);

  const dir = workerDir.replace(/\/+$/, "");
  const skills = asList(doc.skills)
    .map<WorkerSkillEntry | null>((item) => {
      if (typeof item === "string") return { name: item.trim(), description: "", file: null };
      const m = asMap(item);
      const name = asText(m.name) || asText(m.id);
      if (!name) return null;
      const file = asText(m.file) || asText(m.path);
      return {
        name,
        description: firstLine(asText(m.description)),
        file: file ? (file.includes("/") && file.startsWith("companies/") ? file : `${dir}/${file.replace(/^\.\//, "")}`) : null,
      };
    })
    .filter((s): s is WorkerSkillEntry => s !== null && s.name !== "");

  return {
    status: asText(worker.status) || asText(doc.status),
    rows,
    asksBefore,
    contextFiles: fileList(asMap(doc.context).base),
    knowledgeFiles: fileList(doc.knowledge),
    skills,
  };
}

/**
 * Match skills without a declared file to the files in the worker's skills
 * folder (`skills/<name>.md` or `skills/<name>/SKILL.md`).
 */
export function resolveSkillFiles(
  skills: readonly WorkerSkillEntry[],
  skillPaths: readonly string[],
): WorkerSkillEntry[] {
  return skills.map((skill) => {
    if (skill.file) return skill;
    const lower = skill.name.toLowerCase();
    const hit =
      skillPaths.find((p) => p.toLowerCase().endsWith(`/skills/${lower}.md`)) ??
      skillPaths.find((p) => p.toLowerCase().endsWith(`/skills/${lower}/skill.md`)) ??
      null;
    return { ...skill, file: hit };
  });
}

/** The status word the list and pane both show: the worker's own status. */
export function workerStatusLabel(status: string): string {
  const s = status.trim().toLowerCase();
  if (!s) return "Active";
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Claude Code prompt that runs one skill of a worker through /run. */
export function workerSkillRunPrompt(workerId: string, skill: string): string {
  return `/run ${workerId} ${skill}`;
}
