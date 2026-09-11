<script lang="ts">
  /**
   * One capture on the Ideas board (US-009).
   *
   * The card's shape is the information: kind picks the layout, status picks
   * the state treatment, and a thin left rule colour-codes the kind so the
   * board is scannable without reading a word.
   */
  import type { IdeaCapture, IdeaKind, IdeaStatus } from '../../stores/ideaCaptures';
  import { cardKind, cardMeta, cardTitle, kindLabel, readTimeMinutes } from './ideaSearch';

  interface Props {
    record: IdeaCapture;
    /** Authorized data-URL thumbnail, or null while unavailable. */
    thumbnail?: string | null;
    /** "Yes" on the low-confidence strip: keep the kind, promote the status. */
    onaccept?: (record: IdeaCapture) => void;
    /** "Just an image": demote to a plain image card. */
    ondismiss?: (record: IdeaCapture) => void;
  }

  const { record, thumbnail = null, onaccept, ondismiss }: Props = $props();

  const kind = $derived<Exclude<IdeaKind, 'unknown'>>(cardKind(record));
  const status = $derived<IdeaStatus>(record.status);
  const title = $derived(cardTitle(record));
  const meta = $derived(cardMeta(record));
  const extracted = $derived((record.extracted ?? {}) as Record<string, unknown>);

  function text(key: string): string {
    const value = extracted[key];
    return typeof value === 'string' ? value : '';
  }

  const palette = $derived(
    Array.isArray(extracted.palette)
      ? (extracted.palette as unknown[]).filter(
          (hex): hex is string => typeof hex === 'string' && /^#[0-9a-f]{3,8}$/i.test(hex),
        )
      : [],
  );

  const readTime = $derived(readTimeMinutes(text('body') || record.ocr_text || ''));
  const handle = $derived(text('handle'));
  const avatarInitial = $derived((text('author') || record.provenance?.app || '?').charAt(0));

  /** "an X post" / "a Quote" — X reads as a vowel ("ex"), so it takes "an". */
  const claimedPhrase = $derived.by(() => {
    const label = kindLabel(record.kind);
    const article = /^[aeioux]/i.test(label) ? 'an' : 'a';
    return `${article} ${label}`;
  });
</script>

<article
  class="idea-card"
  data-kind={kind}
  data-status={status}
  data-testid="idea-card"
>
  <span class="idea-rule" aria-hidden="true"></span>
  <span class="ctype">{kindLabel(kind)}</span>

  {#if status === 'pending'}
    <div class="shot pending" data-testid="idea-card-pending">
      {#if thumbnail}
        <img src={thumbnail} alt="" />
      {/if}
      <span class="shimmer" aria-hidden="true"></span>
    </div>
    <div class="cbody">
      <span class="reading" data-testid="idea-card-reading">Reading…</span>
      <div class="cmeta">{meta}</div>
    </div>
  {:else}
    {#if kind === 'image' || kind === 'product'}
      <div class="shot">
        {#if thumbnail}
          <img src={thumbnail} alt={title} />
        {:else}
          <span class="shot-fallback" aria-hidden="true"></span>
        {/if}
      </div>
    {:else if kind === 'color'}
      <div class="swatches" data-testid="idea-card-swatches">
        {#each palette as hex (hex)}
          <span class="swatch" style="background:{hex}" title={hex}></span>
        {/each}
      </div>
    {/if}

    <div class="cbody">
      {#if kind === 'x_post'}
        <div class="xhead" data-testid="idea-card-xhead">
          <span class="avatar" aria-hidden="true">{avatarInitial}</span>
          <span class="xname">{text('author') || title}</span>
          {#if handle}<span class="xhandle">{handle}</span>{/if}
        </div>
        <p class="ctitle xbody">{text('body') || title}</p>
      {:else if kind === 'quote'}
        <blockquote class="cquote" data-testid="idea-card-quote">{text('text') || title}</blockquote>
        {#if text('attribution')}
          <div class="cmeta">{text('attribution')}</div>
        {/if}
      {:else if kind === 'article'}
        <p class="ctitle">{text('title') || title}</p>
        <div class="cmeta" data-testid="idea-card-readtime">
          {text('source') || meta} · {readTime} min read
        </div>
      {:else if kind === 'product'}
        <p class="ctitle">{text('name') || title}</p>
        <div class="cmeta">
          {#if text('price')}<span class="cprice">{text('price')}</span>{/if}
          {text('source') || meta}
        </div>
      {:else}
        <p class="ctitle">{text('caption') || title}</p>
      {/if}

      {#if kind !== 'article' && kind !== 'product' && kind !== 'quote'}
        <div class="cmeta">{meta}</div>
      {/if}

      {#if record.tags?.length}
        <div class="ctags">
          {#each record.tags.slice(0, 4) as tag (tag)}
            <span class="ctag">{tag}</span>
          {/each}
        </div>
      {/if}

      {#if record.cited_count > 0}
        <div class="cited idea-card-cited" data-testid="idea-card-cited">
          <span class="cited-dot" aria-hidden="true"></span>
          Cited {record.cited_count}× by agents
        </div>
      {/if}
    </div>
  {/if}

  {#if status === 'low_confidence'}
    <div class="idea-lowconf-strip" data-testid="idea-lowconf-strip">
      <span class="lowconf-q">Looks like {claimedPhrase}?</span>
      <button type="button" class="idea-lowconf-accept" onclick={() => onaccept?.(record)}>
        Yes
      </button>
      <button type="button" class="idea-lowconf-dismiss" onclick={() => ondismiss?.(record)}>
        Just an image
      </button>
    </div>
  {/if}
</article>

<style>
  /* Kind rule colours. The storyboard's cyan / warm pink / indigo have no
     desktop-alt token, so they are declared here as component-scoped custom
     properties rather than inlined as hex in markup. */
  .idea-card {
    --idea-rule-post: var(--blue);
    --idea-rule-article: #2aa6b8;
    --idea-rule-image: #d2748f;
    --idea-rule-quote: var(--amber);
    --idea-rule-color: var(--emerald);
    --idea-rule-product: #5d5fd3;
    --idea-rule: var(--border-strong);
    --font-accent: Fraunces, Georgia, 'Times New Roman', serif;

    position: relative;
    break-inside: avoid;
    margin: 0 0 10px;
    background: var(--surface-raise);
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    font-family: var(--font-sans);
    color: var(--fg);
  }

  .idea-card[data-kind='x_post'] { --idea-rule: var(--idea-rule-post); }
  .idea-card[data-kind='article'] { --idea-rule: var(--idea-rule-article); }
  .idea-card[data-kind='image'] { --idea-rule: var(--idea-rule-image); }
  .idea-card[data-kind='quote'] { --idea-rule: var(--idea-rule-quote); }
  .idea-card[data-kind='color'] { --idea-rule: var(--idea-rule-color); }
  .idea-card[data-kind='product'] { --idea-rule: var(--idea-rule-product); }

  /* Positioned indicator, not a border-left (repo DESIGN.md). */
  .idea-rule {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--idea-rule);
  }

  .ctype {
    position: absolute;
    top: 6px;
    right: 8px;
    z-index: 1;
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted-3);
  }

  .shot {
    position: relative;
    height: 92px;
    overflow: hidden;
    background: var(--surface-panel);
  }

  .shot img {
    width: 100%;
    height: 92px;
    object-fit: cover;
    display: block;
  }

  .shot-fallback {
    display: block;
    width: 100%;
    height: 92px;
    background: var(--surface-panel);
  }

  .shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      100deg,
      transparent 20%,
      var(--surface-raise) 50%,
      transparent 80%
    );
    opacity: 0.55;
    animation: idea-shimmer 1400ms ease-out infinite;
  }

  @keyframes idea-shimmer {
    from { transform: translateX(-60%); }
    to { transform: translateX(60%); }
  }

  .reading {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .swatches {
    display: flex;
    height: 42px;
  }

  .swatch { flex: 1 1 0; }

  .cbody { padding: 13px; }

  .ctitle {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--fg);
  }

  .xbody { margin-top: 6px; }

  .cquote {
    margin: 0;
    font-family: var(--font-accent);
    font-style: italic;
    font-size: 13px;
    line-height: 1.4;
    color: var(--fg);
  }

  .cmeta {
    margin-top: 6px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  .cprice { color: var(--fg); margin-right: 6px; }

  .xhead {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    text-transform: uppercase;
    color: var(--surface-raise);
    background: linear-gradient(135deg, var(--idea-rule-post), var(--idea-rule-product));
  }

  .xname { font-size: 12px; }

  .xhandle {
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--muted);
  }

  .ctags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }

  .ctag {
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 4px;
  }

  .cited {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--emerald);
  }

  .cited-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--emerald);
  }

  .idea-lowconf-strip {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 8px 13px;
    border-top: 1px solid var(--border);
    background: var(--surface-panel);
  }

  .lowconf-q {
    flex: 1 1 auto;
    font-size: 11.5px;
    color: var(--muted);
  }

  .idea-lowconf-strip button {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg);
    background: var(--surface-raise);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 3px 7px;
    cursor: pointer;
    transition: opacity 150ms ease-out;
  }

  .idea-lowconf-strip button:hover { opacity: 0.78; }

  @media (prefers-reduced-motion: reduce) {
    .shimmer { animation: none; }
    .idea-lowconf-strip button { transition: none; }
  }
</style>
