<script lang="ts">
  /**
   * NoteView: the reading view for one Markdown note in the Files explorer.
   *
   * Frontmatter becomes a properties block, the body renders through the
   * shared CSP-safe Markdown renderer, and `[[wikilinks]]` become links to
   * files in the same vault (unresolved ones are shown dimmed, as Obsidian
   * does). Headings are numbered in the DOM so the outline can scroll to them.
   */
  import { tick } from "svelte";
  import { renderMarkdown } from "../../common/markdown.js";
  import { outlineOf, splitFrontmatter, type LinkResolver, type NoteProperty, type OutlineItem } from "./vault-model.js";

  interface Props {
    path: string;
    source: string;
    resolver: LinkResolver | null;
    onopen: (path: string, opts: { newTab: boolean }) => void;
    onoutline?: (items: OutlineItem[]) => void;
    /** Heading index to scroll to; bumping `scrollSeq` repeats the request. */
    scrollTo?: { index: number; seq: number } | null;
  }

  let { path, source, resolver, onopen, onoutline, scrollTo = null }: Props = $props();

  let article = $state<HTMLElement | null>(null);

  const parsed = $derived(splitFrontmatter(source));
  // A note that opens with its own H1 uses it as the page title, so the
  // title is not shown twice; otherwise the file name is the title.
  const titled = $derived.by(() => {
    const m = parsed.body.match(/^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/);
    return m
      ? { title: m[1].replace(/[*_`]/g, ""), body: parsed.body.slice(m[0].length) }
      : { title: path.split("/").pop()?.replace(/\.(md|markdown)$/i, "") ?? path, body: parsed.body };
  });
  // `![[embed]]` has no inline rendering here; show it as a link.
  const html = $derived(renderMarkdown(titled.body.replace(/!\[\[/g, "[[")));
  const outline = $derived(outlineOf(titled.body));
  const words = $derived(
    titled.body.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter((w) => /\w/.test(w)).length,
  );

  $effect(() => {
    onoutline?.(outline);
  });

  // Decorate the rendered article: heading anchors and link state.
  $effect(() => {
    void html;
    const el = article;
    const r = resolver;
    if (!el) return;
    void tick().then(() => {
      el.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h, i) => {
        h.setAttribute("data-heading-index", String(i));
      });
      el.querySelectorAll<HTMLElement>(".markdown-wikilink").forEach((link) => {
        const target = link.getAttribute("title") ?? "";
        const resolved = r?.resolve(target, path) ?? null;
        link.dataset.resolved = resolved ? "true" : "false";
        if (resolved) {
          link.dataset.target = resolved;
          link.setAttribute("role", "link");
          link.setAttribute("tabindex", "0");
        }
      });
    });
  });

  $effect(() => {
    const req = scrollTo;
    const el = article;
    if (!req || !el) return;
    el.querySelector(`[data-heading-index="${req.index}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function followLink(event: MouseEvent | KeyboardEvent): void {
    const link = (event.target as HTMLElement | null)?.closest<HTMLElement>(".markdown-wikilink");
    const target = link?.dataset.target;
    if (!target) return;
    if (event instanceof KeyboardEvent && event.key !== "Enter") return;
    event.preventDefault();
    onopen(target, { newTab: event.metaKey || event.ctrlKey });
  }

  function valueList(p: NoteProperty): string[] {
    return Array.isArray(p.value) ? p.value : [p.value];
  }

  const LIST_KEYS = new Set(["tags", "aliases", "owners", "people", "clients", "related"]);
</script>

<div class="note">
  <header class="note-head">
    <h1 class="note-title">{titled.title}</h1>
    <p class="note-meta">
      {words.toLocaleString()} {words === 1 ? "word" : "words"}{outline.length ? ` · ${outline.length} ${outline.length === 1 ? "section" : "sections"}` : ""}
    </p>
  </header>

  {#if parsed.properties.length > 0}
    <dl class="props" data-testid="note-properties">
      {#each parsed.properties as prop (prop.key)}
        <div class="prop">
          <dt>{prop.key}</dt>
          <dd>
            {#if Array.isArray(prop.value) || LIST_KEYS.has(prop.key.toLowerCase())}
              <span class="pills">
                {#each valueList(prop) as v, i (i)}
                  <span class="pill" class:tag={prop.key.toLowerCase() === "tags"}>{prop.key.toLowerCase() === "tags" ? `#${v.replace(/^#/, "")}` : v}</span>
                {/each}
              </span>
            {:else}
              {prop.value || "—"}
            {/if}
          </dd>
        </div>
      {/each}
    </dl>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <article
    class="markdown-body"
    bind:this={article}
    onclick={followLink}
    onkeydown={followLink}
    data-testid="note-body"
  >
    {@html html}
  </article>
</div>

<style>
  .note {
    box-sizing: border-box;
    max-width: 740px;
    margin: 0 auto;
    padding: 40px 48px 120px;
  }
  .note-head {
    margin-bottom: 18px;
  }
  .note-title {
    margin: 0;
    color: var(--v4-text-1);
    font-size: 30px;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  .note-meta {
    margin: 6px 0 0;
    color: var(--v4-text-3);
    font-size: 12px;
  }
  .props {
    display: grid;
    gap: 2px;
    margin: 0 0 26px;
    padding: 10px 0;
    border-top: 1px solid var(--v4-hairline);
    border-bottom: 1px solid var(--v4-hairline);
  }
  .prop {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 12px;
    align-items: baseline;
    padding: 4px 0;
    font-size: 13px;
  }
  .prop dt {
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .prop dd {
    margin: 0;
    color: var(--v4-text-1);
    overflow-wrap: anywhere;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .pill {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-size: 12px;
  }
  .pill.tag {
    color: var(--v4-link);
  }

  .markdown-body {
    color: var(--v4-text-1);
    font-size: 15.5px;
    line-height: 1.72;
    overflow-wrap: anywhere;
  }
  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    color: var(--v4-text-1);
    font-weight: 620;
    letter-spacing: -0.01em;
    line-height: 1.3;
    scroll-margin-top: 24px;
  }
  .markdown-body :global(h1) { font-size: 24px; margin: 1.6em 0 0.6em; }
  .markdown-body :global(h2) { font-size: 20px; margin: 1.5em 0 0.5em; padding-bottom: 6px; border-bottom: 1px solid var(--v4-hairline); }
  .markdown-body :global(h3) { font-size: 17px; margin: 1.3em 0 0.4em; }
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) { font-size: 15px; margin: 1.2em 0 0.3em; color: var(--v4-text-2); }
  .markdown-body :global(:first-child) { margin-top: 0; }
  .markdown-body :global(p) { margin: 0 0 0.9em; }
  .markdown-body :global(ul),
  .markdown-body :global(ol) { margin: 0 0 0.9em; padding-left: 1.4em; }
  .markdown-body :global(li) { margin: 0.2em 0; }
  .markdown-body :global(li::marker) { color: var(--v4-text-3); }
  .markdown-body :global(a) {
    color: var(--v4-link);
    text-decoration: none;
    border-bottom: 1px solid color-mix(in srgb, var(--v4-link) 35%, transparent);
  }
  .markdown-body :global(a:hover) { border-bottom-color: var(--v4-link); }
  .markdown-body :global(.markdown-wikilink) {
    color: var(--v4-link);
    border-radius: 3px;
    cursor: default;
  }
  .markdown-body :global(.markdown-wikilink[data-resolved="true"]) {
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--v4-link) 40%, transparent);
    text-underline-offset: 3px;
  }
  .markdown-body :global(.markdown-wikilink[data-resolved="true"]:hover),
  .markdown-body :global(.markdown-wikilink[data-resolved="true"]:focus-visible) {
    background: color-mix(in srgb, var(--v4-link) 12%, transparent);
    text-decoration-color: var(--v4-link);
    outline: none;
  }
  .markdown-body :global(.markdown-wikilink[data-resolved="false"]) {
    color: var(--v4-text-3);
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
  .markdown-body :global(code) {
    padding: 0.12em 0.36em;
    border-radius: 5px;
    background: var(--v4-control-faint);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.86em;
  }
  .markdown-body :global(pre) {
    margin: 0 0 1em;
    padding: 14px 16px;
    border: 1px solid var(--v4-hairline);
    border-radius: 10px;
    background: var(--v4-inset);
    overflow-x: auto;
    line-height: 1.55;
  }
  .markdown-body :global(pre code) { padding: 0; background: none; font-size: 12.5px; }
  .markdown-body :global(blockquote) {
    margin: 0 0 1em;
    padding: 2px 0 2px 16px;
    border-left: 3px solid var(--v4-hairline);
    color: var(--v4-text-2);
  }
  .markdown-body :global(hr) { margin: 2em 0; border: 0; border-top: 1px solid var(--v4-hairline); }
  .markdown-body :global(table) {
    width: 100%;
    margin: 0 0 1.1em;
    border-collapse: collapse;
    font-size: 13.5px;
    display: block;
    overflow-x: auto;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    padding: 7px 10px;
    border-bottom: 1px solid var(--v4-hairline);
    text-align: left;
    vertical-align: top;
  }
  .markdown-body :global(th) { color: var(--v4-text-2); font-weight: 600; }
  .markdown-body :global(input[type="checkbox"]) { margin-right: 6px; accent-color: var(--v4-link); }

  @media (max-width: 900px) {
    .note { padding: 28px 24px 80px; }
    .prop { grid-template-columns: 110px 1fr; }
  }
</style>
