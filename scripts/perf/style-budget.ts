/**
 * Pure CSS-budget detectors used by scripts/perf-budget-contract.test.ts.
 *
 * WHY THESE EXIST
 * ---------------
 * HQ Sync runs a TRANSPARENT native window with a real macOS glass layer
 * (NSGlassEffectView, see apps/sync/src-tauri/src/glass.rs) painted behind the
 * webview. Every CSS `backdrop-filter` on top of that is a SECOND, redundant
 * GPU blur pass: the compositor has to re-read the backdrop and re-blur it for
 * the element's whole box on every frame the box is touched. On a permanently
 * visible full-height surface (the conversation rail, a full-width button row)
 * that means a full-rail blur on every hover, scroll and caret blink, which is
 * exactly the choppiness the perf pass removed.
 *
 * Transient surfaces -- popovers, context menus, dialogs, the command palette,
 * tooltips, the emoji picker -- are fine: they exist for a few hundred
 * milliseconds and the blur is what makes them read as floating glass.
 *
 * SCOPE. Only packages/ui/src is checked. `apps/sync/src/desktop-alt/` (v4/,
 * panels/, pages/, styles/) is DEAD code: `apps/sync/src/desktop-alt/boot.ts`
 * hard-returns 'hq-work', so the @hq/ui workspace is the only shell that ever
 * mounts. Budgeting dead CSS would only generate busywork.
 *
 * These are deliberately pure functions over file CONTENT strings so the
 * detectors themselves are unit-tested against inline fixtures (a guard nobody
 * has watched fail is not a guard).
 */

export interface StyleFinding {
  /** Repo-relative file path the finding came from. */
  file: string;
  /** 1-based line number of the offending declaration. */
  line: number;
  /** The nearest enclosing selector text, normalised to one line. */
  selector: string;
  /** The offending declaration, trimmed. */
  declaration: string;
}

/** Strip `/* ... *\/` comments while preserving line breaks (line numbers must survive). */
export function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/**
 * The selector that owns `lineIndex`: walk backwards to the nearest line that
 * opens a block, then back up over any leading comma-continued selector lines
 * (`.a,\n.b {`). At-rules (`@media`, `@supports`, `@keyframes`) are skipped so
 * a declaration inside a media query still reports the real selector.
 */
export function enclosingSelector(lines: string[], lineIndex: number): string {
  let i = lineIndex;
  while (i >= 0 && !/\{\s*$/.test(lines[i])) i -= 1;
  if (i < 0) return "<unknown>";

  const parts = [lines[i].replace(/\{\s*$/, "").trim()];
  let j = i - 1;
  while (j >= 0 && /,\s*$/.test(lines[j])) {
    parts.unshift(lines[j].trim());
    j -= 1;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Every `backdrop-filter` / `-webkit-backdrop-filter` declaration that actually
 * turns a blur ON. `backdrop-filter: none` (the reduced-transparency and
 * prefers-reduced-motion escape hatches) is the CURE, not the disease, so it is
 * never reported.
 */
export function findBackdropFilters(
  file: string,
  source: string,
): StyleFinding[] {
  const lines = stripBlockComments(source).split("\n");
  const findings: StyleFinding[] = [];

  lines.forEach((raw, index) => {
    const declaration = raw.trim();
    if (!/^-?(webkit-)?backdrop-filter\s*:/.test(declaration)) return;
    // `backdrop-filter: var(` may wrap onto the next line; only `: none` on the
    // same line is an unambiguous disable.
    if (/:\s*none\s*;?\s*$/.test(declaration)) return;
    findings.push({
      file,
      line: index + 1,
      selector: enclosingSelector(lines, index),
      declaration,
    });
  });

  return findings;
}

/**
 * Properties whose animation forces layout on every frame. Animating any of
 * these runs style + layout + paint + composite for the element's whole
 * subtree, 60x a second, on the main thread. `transform` and `opacity` are
 * composited on the GPU and cost effectively nothing.
 */
export const LAYOUT_PROPERTIES = [
  "width",
  "height",
  "top",
  "left",
  "right",
  "bottom",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "flex-basis",
] as const;

const LAYOUT_PROPERTY_SET = new Set<string>(LAYOUT_PROPERTIES);

/**
 * `transition:` shorthands / `transition-property:` lists that name a
 * layout-triggering property, plus `transition: all` (which is worse: it opts
 * every property in, including ones added later by someone who never read this
 * file).
 *
 * The fix is always the same shape: animate `transform` instead. A progress
 * fill animates `transform: scaleX(...)` with `transform-origin: left`, which
 * is what packages/ui/src/projects/ProjectRow.svelte now does.
 */
export function findLayoutTransitions(
  file: string,
  source: string,
): StyleFinding[] {
  const lines = stripBlockComments(source).split("\n");
  const findings: StyleFinding[] = [];

  lines.forEach((raw, index) => {
    const declaration = raw.trim();
    const match = /^transition(-property)?\s*:\s*([^;]*)/.exec(declaration);
    if (!match) return;

    const value = match[2];
    // Svelte transition directives (`transition:fade`) are JS, not CSS, and
    // have no colon-space value form -- the regex above already requires
    // `transition:` followed by a value, so `transition:fade={{...}}` in markup
    // is excluded by requiring the line to end in `;` or be a bare value.
    if (/^[a-zA-Z]+\s*=/.test(value)) return;

    const offenders = value
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((prop) => prop === "all" || LAYOUT_PROPERTY_SET.has(prop));

    if (offenders.length === 0) return;

    findings.push({
      file,
      line: index + 1,
      selector: enclosingSelector(lines, index),
      declaration: `${declaration} (animates: ${[...new Set(offenders)].join(", ")})`,
    });
  });

  return findings;
}

/**
 * Properties that must never appear inside a `@keyframes` block. A keyframe
 * animation runs unconditionally for its whole duration -- often infinitely,
 * as with a loading shimmer -- so a non-composited property here burns main
 * thread for as long as the element is on screen, whether or not anyone is
 * interacting.
 *
 * `background-position` is the classic offender: the "moving gradient" shimmer
 * repaints the element every frame. The composited equivalent is a gradient
 * overlay moved with `transform: translateX()`, which is what the skeleton
 * shimmer was converted to.
 */
export const NON_COMPOSITED_KEYFRAME_PROPERTIES = [
  "background-position",
  "background-position-x",
  "background-position-y",
  "background-size",
  "width",
  "height",
  "top",
  "left",
  "right",
  "bottom",
  "box-shadow",
] as const;

export interface KeyframeFinding extends StyleFinding {
  /** The `@keyframes` animation name. */
  animation: string;
}

/**
 * Scan every `@keyframes` block for non-composited properties. The block is
 * located by brace-matching from the `@keyframes` line so nested `0% { ... }`
 * steps are handled.
 */
export function findNonCompositedKeyframes(
  file: string,
  source: string,
): KeyframeFinding[] {
  const stripped = stripBlockComments(source);
  const lines = stripped.split("\n");
  const findings: KeyframeFinding[] = [];
  const banned = new Set<string>(NON_COMPOSITED_KEYFRAME_PROPERTIES);

  const opener = /@(?:-webkit-)?keyframes\s+([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(stripped)) !== null) {
    const animation = match[1];
    // Brace-match forward to the end of the @keyframes block.
    const braceStart = stripped.indexOf("{", match.index);
    if (braceStart === -1) continue;
    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < stripped.length; i += 1) {
      if (stripped[i] === "{") depth += 1;
      else if (stripped[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    const startLine = stripped.slice(0, braceStart).split("\n").length - 1;
    const endLine = stripped.slice(0, end).split("\n").length - 1;

    for (let i = startLine; i <= endLine; i += 1) {
      const declaration = lines[i].trim();
      const prop = /^([a-z-]+)\s*:/.exec(declaration)?.[1];
      if (!prop || !banned.has(prop)) continue;
      findings.push({
        file,
        line: i + 1,
        selector: `@keyframes ${animation}`,
        declaration,
        animation,
      });
    }
  }

  return findings;
}

/** Render findings as a readable, greppable failure message. */
export function formatFindings(findings: StyleFinding[]): string {
  return findings
    .map((f) => `  ${f.file}:${f.line}  ${f.selector}  ->  ${f.declaration}`)
    .join("\n");
}
