<script lang="ts">
  /**
   * One capture on the Ideas board.
   *
   * The card's SHAPE is the information: kind picks the layout, status picks
   * the state treatment. Unlike the desktop-alt original there is no coloured
   * left kind-rule — the shell's design rules keep accents monochrome and
   * reserve colour for semantic state, so the kind reads from the layout plus
   * the type label instead.
   */
  import type { IdeaCapture, IdeaKind, IdeaStatus } from "@hq/platform";
  import {
    cardKind,
    cardMeta,
    cardTitle,
    kindLabel,
    readTimeMinutes,
  } from "./ideaSearch.js";

  interface Props {
    record: IdeaCapture;
    /** Authorized data-URL thumbnail, or null while unavailable. */
    thumbnail?: string | null;
    /** "Yes" on the low-confidence strip: keep the kind, promote the status. */
    onaccept?: (record: IdeaCapture) => void;
    /** "Just an image": demote to a plain image card. */
    ondismiss?: (record: IdeaCapture) => void;
    /** Open the card detail pane. */
    onopen?: (record: IdeaCapture) => void;
  }

  let {
    record,
    thumbnail = null,
    onaccept,
    ondismiss,
    onopen,
  }: Props = $props();

  const kind = $derived<Exclude<IdeaKind, "unknown">>(cardKind(record));
  const status = $derived<IdeaStatus>(record.status);
  const title = $derived(cardTitle(record));
  const meta = $derived(cardMeta(record));
  const extracted = $derived((record.extracted ?? {}) as Record<string, unknown>);

  function text(key: string): string {
    const value = extracted[key];
    return typeof value === "string" ? value : "";
  }

  const palette = $derived(
    Array.isArray(extracted.palette)
      ? (extracted.palette as unknown[]).filter(
          (hex): hex is string =>
            typeof hex === "string" && /^#[0-9a-f]{3,8}$/i.test(hex),
        )
      : [],
  );

  /** De-duped so repeated tags cannot collide as keys, capped at four. */
  const tags = $derived([...new Set(record.tags ?? [])].slice(0, 4));

  const readTime = $derived(
    readTimeMinutes(text("body") || record.ocr_text || ""),
  );
  const handle = $derived(text("handle"));
  const avatarInitial = $derived(
    (text("author") || record.provenance?.app || "?").charAt(0),
  );

  /** "an X post" / "a Quote" — X reads as a vowel ("ex"), so it takes "an". */
  const claimedPhrase = $derived.by(() => {
    const label = kindLabel(record.kind);
    const article = /^[aeioux]/i.test(label) ? "an" : "a";
    return `${article} ${label}`;
  });
</script>

<div
  class="idea-card"
  data-id={record.id}
  data-kind={kind}
  data-status={status}
  data-testid="idea-card"
  role="button"
  tabindex="0"
  onclick={() => onopen?.(record)}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onopen?.(record);
    }
  }}
>
  <span class="idea-type">{kindLabel(kind)}</span>

  {#if status === "pending"}
    <div class="idea-shot idea-pending" data-testid="idea-card-pending">
      {#if thumbnail}
        <img src={thumbnail} alt="" />
      {/if}
      <span class="idea-shimmer" aria-hidden="true"></span>
    </div>
    <div class="idea-body">
      <span class="idea-reading" data-testid="idea-card-reading">Reading…</span>
      <div class="idea-meta">{meta}</div>
    </div>
  {:else}
    {#if kind === "image" || kind === "product"}
      <div class="idea-shot">
        {#if thumbnail}
          <img src={thumbnail} alt={title} />
        {:else}
          <span class="idea-shot-fallback" aria-hidden="true"></span>
        {/if}
      </div>
    {:else if kind === "color"}
      <div class="idea-swatches" data-testid="idea-card-swatches">
        {#each palette as hex, i (i)}
          <span class="idea-swatch" style="background:{hex}" title={hex}></span>
        {/each}
      </div>
    {/if}

    <div class="idea-body">
      {#if kind === "x_post"}
        <div class="idea-xhead" data-testid="idea-card-xhead">
          <span class="idea-avatar" aria-hidden="true">{avatarInitial}</span>
          <span class="idea-xname">{text("author") || title}</span>
          {#if handle}<span class="idea-xhandle">{handle}</span>{/if}
        </div>
        <p class="idea-title idea-xbody">{text("body") || title}</p>
      {:else if kind === "quote"}
        <blockquote class="idea-quote" data-testid="idea-card-quote">
          {text("text") || title}
        </blockquote>
        {#if text("attribution")}
          <div class="idea-meta">{text("attribution")}</div>
        {/if}
      {:else if kind === "article"}
        <p class="idea-title">{text("title") || title}</p>
        <div class="idea-meta" data-testid="idea-card-readtime">
          {text("source") || meta} · {readTime} min read
        </div>
      {:else if kind === "product"}
        <p class="idea-title">{text("name") || title}</p>
        <div class="idea-meta">
          {#if text("price")}<span class="idea-price">{text("price")}</span>{/if}
          {text("source") || meta}
        </div>
      {:else}
        <p class="idea-title">{text("caption") || title}</p>
      {/if}

      {#if kind !== "article" && kind !== "product" && kind !== "quote"}
        <div class="idea-meta">{meta}</div>
      {/if}

      {#if record.tags?.length}
        <div class="idea-tags">
          {#each tags as tag, i (i)}
            <span class="idea-tag">{tag}</span>
          {/each}
        </div>
      {/if}

      {#if record.cited_count > 0}
        <div class="idea-cited" data-testid="idea-card-cited">
          <span class="idea-cited-dot" aria-hidden="true"></span>
          Cited {record.cited_count}× by agents
        </div>
      {/if}
    </div>
  {/if}

  {#if status === "low_confidence"}
    <div class="idea-lowconf" data-testid="idea-lowconf-strip">
      <span class="idea-lowconf-q">Looks like {claimedPhrase}?</span>
      <button
        type="button"
        class="idea-lowconf-accept"
        onclick={(e) => {
          e.stopPropagation();
          onaccept?.(record);
        }}
      >
        Yes
      </button>
      <button
        type="button"
        class="idea-lowconf-dismiss"
        onclick={(e) => {
          e.stopPropagation();
          ondismiss?.(record);
        }}
      >
        Just an image
      </button>
    </div>
  {/if}
</div>

<style>
  .idea-card {
    position: relative;
    break-inside: avoid;
    margin: 0 0 10px;
    border: 1px solid color-mix(in srgb, var(--t1) 10%, transparent);
    border-radius: 6px;
    background: var(--raised, transparent);
    color: var(--t1);
    overflow: hidden;
    cursor: pointer;
    text-align: left;
  }

  .idea-card:hover {
    border-color: color-mix(in srgb, var(--t1) 18%, transparent);
  }

  .idea-card:focus-visible {
    outline: 2px solid var(--t1);
    outline-offset: 2px;
  }

  .idea-type {
    position: absolute;
    top: 6px;
    right: 8px;
    z-index: 1;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--t3);
  }

  .idea-shot {
    position: relative;
    height: 92px;
    overflow: hidden;
    background: color-mix(in srgb, var(--t1) 6%, transparent);
  }

  .idea-shot img {
    width: 100%;
    height: 92px;
    object-fit: cover;
    display: block;
  }

  .idea-shot-fallback {
    display: block;
    width: 100%;
    height: 92px;
  }

  .idea-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      100deg,
      transparent 20%,
      color-mix(in srgb, var(--t1) 10%, transparent) 50%,
      transparent 80%
    );
    animation: idea-shimmer 1400ms ease-out infinite;
  }

  @keyframes idea-shimmer {
    from {
      transform: translateX(-60%);
    }
    to {
      transform: translateX(60%);
    }
  }

  .idea-reading {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--t3);
  }

  .idea-swatches {
    display: flex;
    height: 42px;
  }

  .idea-swatch {
    flex: 1 1 0;
  }

  .idea-body {
    padding: 12px;
  }

  .idea-title {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.35;
    color: var(--t1);
  }

  .idea-xbody {
    margin-top: 6px;
    font-weight: 400;
  }

  .idea-quote {
    margin: 0;
    font-style: italic;
    font-size: 13px;
    line-height: 1.4;
    color: var(--t1);
  }

  .idea-meta {
    margin-top: 6px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--t3);
  }

  .idea-price {
    color: var(--t1);
    margin-right: 6px;
  }

  .idea-xhead {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .idea-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--t1);
    background: color-mix(in srgb, var(--t1) 12%, transparent);
  }

  .idea-xname {
    font-size: 13px;
  }

  .idea-xhandle {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    color: var(--t3);
  }

  .idea-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }

  .idea-tag {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--t3);
    border: 1px solid color-mix(in srgb, var(--t1) 10%, transparent);
    border-radius: 6px;
    padding: 1px 5px;
  }

  /* Colour here is semantic state (an agent actually used this capture). */
  .idea-cited {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 8px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ok, #3fb950);
  }

  .idea-cited-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
  }

  .idea-lowconf {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 8px 12px;
    border-top: 1px solid color-mix(in srgb, var(--t1) 8%, transparent);
  }

  .idea-lowconf-q {
    flex: 1 1 auto;
    font-size: 13px;
    color: var(--t2);
  }

  .idea-lowconf button {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--t1);
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--t1) 14%, transparent);
    border-radius: 6px;
    padding: 3px 8px;
    cursor: pointer;
  }

  .idea-lowconf button:hover {
    background: var(--sel, color-mix(in srgb, var(--t1) 8%, transparent));
  }

  .idea-lowconf button:focus-visible {
    outline: 2px solid var(--t1);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .idea-shimmer {
      animation: none;
    }
  }
</style>
