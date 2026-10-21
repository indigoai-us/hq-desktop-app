<script lang="ts">
  /**
   * Profile photo row control, shared by Settings › Profile and Public profile.
   *
   *   • Picking (or dropping) a photo saves it at once with a centered crop.
   *   • "Adjust" opens the crop editor inside the row; Done saves the new crop.
   *   • "Undo" briefly offers the previous photo back.
   *   • After a save, an optional line offers the same photo to the other
   *     profile when that profile has no photo or a different one.
   */
  import type { Snippet } from "svelte";
  import RailIcon from "../common/button/RailIcon.svelte";
  import { paintableAvatarSrc } from "../avatars/csp-image-src.js";
  import type { PreparedAvatar } from "./avatar-image.js";
  import PhotoCropEditor from "./PhotoCropEditor.svelte";
  import HqGlow from "./HqGlow.svelte";
  import {
    CENTER_CROP,
    loadPhotoSource,
    PhotoError,
    photoFingerprint,
    cropView,
    renderPhoto,
    sameFingerprint,
    type OtherProfile,
    type PhotoCrop,
    type PhotoSaveResult,
    type PhotoSource,
  } from "./profile-photo.js";

  interface Props {
    photoUrl: string | null;
    initial: string;
    size?: number;
    /** Show the change/adjust controls (false = display only). */
    editable?: boolean;
    disabled?: boolean;
    changeLabel?: string;
    save: (photo: PreparedAvatar) => Promise<PhotoSaveResult>;
    onsaved?: (src: string) => void;
    /** True while the photo is being adjusted or the "use on the other profile" line waits on an answer. */
    onphotobusy?: (open: boolean) => void;
    other?: OtherProfile | null;
    meta?: Snippet;
    /** "row": meta in the middle, buttons on the right (Settings › Profile).
     *  "stacked": buttons over the meta, beside the photo (Public profile). */
    layout?: "row" | "stacked";
    /** "chip": the small Settings button. "button": the page's regular button. */
    buttonStyle?: "chip" | "button";
    testid: string;
    imgTestid: string;
    fallbackTestid: string;
    inputTestid: string;
    changeTestid: string;
  }

  let {
    photoUrl,
    initial,
    size = 48,
    editable = true,
    disabled = false,
    changeLabel = "Change photo",
    save,
    onsaved,
    onphotobusy,
    other = null,
    meta,
    layout = "row",
    buttonStyle = "chip",
    testid,
    imgTestid,
    fallbackTestid,
    inputTestid,
    changeTestid,
  }: Props = $props();

  type Previous = { source: PhotoSource; crop: PhotoCrop } | { url: string } | null;
  type Offer = {
    kind: "empty" | "diff";
    state: "idle" | "busy" | "done" | "error";
    photo: PreparedAvatar;
    thumb: string;
    otherThumb: string | null;
  };

  let fileInput = $state<HTMLInputElement | null>(null);
  /** The photo this control saved last (shown until the parent catches up). */
  let savedSrc = $state<string | null>(null);
  /** Original image + crop for lossless re-adjusting this session. */
  let session = $state<{ source: PhotoSource; crop: PhotoCrop } | null>(null);
  /** The crop being adjusted, shown live in the avatar while the editor is open. */
  let liveCrop = $state<PhotoCrop | null>(null);
  let previous = $state<Previous>(null);
  let status = $state<"idle" | "saving" | "saved" | "crop-saved" | "error" | "retry">("idle");
  /** A save that failed after its automatic retries; Retry re-sends the same photo. */
  let pendingRetry = $state<{
    photo: PreparedAvatar;
    next: { source: PhotoSource; crop: PhotoCrop };
    opts: { kind: "saved" | "crop-saved"; previous: Previous };
  } | null>(null);
  // Quiet automatic retries after a failed upload, before showing Retry.
  const RETRY_DELAYS = [1000, 2000, 4000];
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let errorText = $state("");
  let editing = $state(false);
  let editBusy = $state(false);
  let dropping = $state(false);
  let offer = $state<Offer | null>(null);
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let offerTimer: ReturnType<typeof setTimeout> | undefined;
  let saveSeq = 0;

  $effect(() => {
    onphotobusy?.(editing || (offer !== null && offer.state !== "done"));
  });
  /** Bumped on each successful save to replay the HQ glow around the photo. */
  let glowKey = $state(0);

  const shownSrc = $derived(paintableAvatarSrc(savedSrc ?? photoUrl));
  const live = $derived.by(() => {
    if (!editing || !session || !liveCrop) return null;
    const v = cropView(session.source, liveCrop, size);
    return {
      src: session.source.url,
      style: `width:${v.width}px;height:${v.height}px;transform:translate(calc(-50% + ${v.dx}px), calc(-50% + ${v.dy}px));`,
    };
  });
  const hasPhoto = $derived(Boolean(savedSrc ?? photoUrl));
  // The photo server sends no CORS headers, so the app can only read the pixels
  // of photos it holds locally (picked this session, or a data:/blob: URL).
  // Adjust and Undo need those pixels; without them they stay hidden.
  const canAdjust = $derived(Boolean(session) || readableUrl(savedSrc ?? photoUrl));

  function readableUrl(url: string | null | undefined): boolean {
    return typeof url === "string" && (url.startsWith("data:") || url.startsWith("blob:"));
  }
  const busy = $derived(status === "saving" || editBusy);

  function setStatus(next: typeof status, message = ""): void {
    clearTimeout(statusTimer);
    status = next;
    errorText = message;
    if (next === "saved") statusTimer = setTimeout(() => (status = "idle"), 5000);
    if (next === "crop-saved") statusTimer = setTimeout(() => (status = "idle"), 2500);
  }

  function currentAsPrevious(): Previous {
    if (session) return { source: session.source, crop: session.crop };
    const url = savedSrc ?? photoUrl;
    return readableUrl(url) ? { url: url! } : null;
  }

  async function commit(
    photo: PreparedAvatar,
    next: { source: PhotoSource; crop: PhotoCrop },
    opts: { kind: "saved" | "crop-saved"; previous: Previous },
  ): Promise<boolean> {
    const seq = ++saveSeq;
    setStatus("saving");
    offer = null;
    pendingRetry = null;
    let res: PhotoSaveResult = { ok: false };
    for (let attempt = 0; ; attempt++) {
      try {
        res = await save(photo);
      } catch (err) {
        console.warn("[profile-photo] save failed", err);
        res = { ok: false };
      }
      if (seq !== saveSeq) return false;
      if (res.ok || attempt >= RETRY_DELAYS.length) break;
      await wait(RETRY_DELAYS[attempt]!);
      if (seq !== saveSeq) return false;
    }
    if (!res.ok) {
      pendingRetry = { photo, next, opts };
      setStatus("retry");
      return false;
    }
    const src = paintableAvatarSrc(res.url ?? null) ?? photo.previewDataUrl;
    previous = opts.previous;
    session = next;
    savedSrc = src;
    onsaved?.(src);
    glowKey += 1;
    setStatus(opts.kind);
    void checkOffer(photo);
    return true;
  }

  async function acceptFile(file: File | undefined | null): Promise<void> {
    if (!file || busy || disabled) return;
    if (!file.type.startsWith("image/")) {
      setStatus("error", "Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    editing = false;
    const before = currentAsPrevious();
    setStatus("saving");
    try {
      const source = await loadPhotoSource(file);
      const photo = await renderPhoto(source, CENTER_CROP);
      await commit(photo, { source, crop: CENTER_CROP }, { kind: "saved", previous: before });
    } catch (err) {
      // Only app-written PhotoError copy reaches the screen; anything else is logged.
      if (!(err instanceof PhotoError)) console.warn("[profile-photo] couldn't read the picked image", err);
      setStatus("error", err instanceof PhotoError ? err.message : "Couldn't read that image. Try another photo.");
    }
  }

  function retrySave(): void {
    const pending = pendingRetry;
    if (!pending || busy) return;
    void commit(pending.photo, pending.next, pending.opts);
  }

  async function undo(): Promise<void> {
    const prev = previous;
    if (!prev || busy) return;
    setStatus("saving");
    try {
      const source = "source" in prev ? prev.source : await loadPhotoSource(prev.url);
      const crop = "source" in prev ? prev.crop : CENTER_CROP;
      const photo = await renderPhoto(source, crop);
      await commit(photo, { source, crop }, { kind: "crop-saved", previous: null });
      offer = null;
    } catch {
      setStatus("error", "Couldn't restore the previous photo.");
    }
  }

  async function openEditor(): Promise<void> {
    if (busy || disabled) return;
    if (session) {
      liveCrop = null;
      editing = true;
      setStatus("idle");
      return;
    }
    const url = savedSrc ?? photoUrl;
    if (!url || !readableUrl(url)) {
      fileInput?.click();
      return;
    }
    editBusy = true;
    try {
      session = { source: await loadPhotoSource(url), crop: CENTER_CROP };
      liveCrop = null;
      editing = true;
      setStatus("idle");
    } catch {
      setStatus("error", "Couldn't open this photo. Pick it again to adjust it.");
    } finally {
      editBusy = false;
    }
  }

  async function finishEdit(crop: PhotoCrop): Promise<void> {
    const current = session;
    if (!current) return;
    if (crop.x === current.crop.x && crop.y === current.crop.y && crop.zoom === current.crop.zoom) {
      editing = false;
      return;
    }
    editBusy = true;
    try {
      const photo = await renderPhoto(current.source, crop);
      const ok = await commit(photo, { source: current.source, crop }, {
        kind: "crop-saved",
        previous: { source: current.source, crop: current.crop },
      });
      if (ok) editing = false;
    } catch {
      setStatus("error", "Couldn't save your photo. Try again.");
    } finally {
      editBusy = false;
    }
  }

  async function checkOffer(photo: PreparedAvatar): Promise<void> {
    if (!other) return;
    const seq = saveSeq;
    clearTimeout(offerTimer);
    try {
      const current = await other.current();
      if (seq !== saveSeq || current === undefined) return;
      if (current === null) {
        offer = { kind: "empty", state: "idle", photo, thumb: photo.previewDataUrl, otherThumb: null };
        return;
      }
      // A server photo can't be read (no CORS), so there is nothing to compare.
      if (!readableUrl(current)) return;
      const [mine, theirs] = await Promise.all([
        photoFingerprint(await loadPhotoSource(photo.previewDataUrl)),
        photoFingerprint(await loadPhotoSource(current)),
      ]);
      if (seq !== saveSeq || sameFingerprint(mine, theirs)) return;
      offer = {
        kind: "diff",
        state: "idle",
        photo,
        thumb: photo.previewDataUrl,
        otherThumb: paintableAvatarSrc(current),
      };
    } catch {
      // Can't tell whether the photos match, so don't offer.
    }
  }

  async function applyOffer(): Promise<void> {
    const current = offer;
    if (!current || !other || current.state === "busy") return;
    offer = { ...current, state: "busy" };
    let ok = false;
    for (let attempt = 0; ; attempt++) {
      try {
        ok = await other.apply(current.photo);
      } catch (err) {
        console.warn("[profile-photo] copy to the other profile failed", err);
        ok = false;
      }
      if (offer?.photo !== current.photo) return;
      if (ok || attempt >= RETRY_DELAYS.length) break;
      await wait(RETRY_DELAYS[attempt]!);
      if (offer?.photo !== current.photo) return;
    }
    offer = { ...current, state: ok ? "done" : "error" };
    if (ok) offerTimer = setTimeout(() => (offer = null), 3000);
  }

  const offerText = $derived.by(() => {
    if (!offer || !other) return "";
    const c = other.copy;
    if (offer.state === "done") return offer.kind === "empty" ? c.emptyDone : c.diffDone;
    if (offer.state === "error") return "Couldn't update it.";
    return offer.kind === "empty" ? c.emptyText : c.diffText;
  });
  const offerAction = $derived(
    offer && other ? (offer.kind === "empty" ? other.copy.emptyAction : other.copy.diffAction) : "",
  );

  function onDrag(event: DragEvent, over: boolean): void {
    if (!editable || disabled) return;
    event.preventDefault();
    dropping = over;
  }
</script>

<div class="ppf" data-testid={testid} style={`--ppf-size:${size}px`}>
  {#if editable}
    <span class="avatar-wrap" style={`--ppf-size:${size}px`}>
    {#key glowKey}
      {#if glowKey > 0}
        <HqGlow testid={`${testid}-glow`} />
      {/if}
    {/key}
    <button
      type="button"
      class="avatar"
      class:drop={dropping}
      class:saving={busy}
      style={`--ppf-size:${size}px`}
      aria-label={canAdjust ? "Adjust your photo" : hasPhoto ? "Change your photo" : "Choose a photo"}
      disabled={disabled}
      data-testid={`${testid}-avatar`}
      onclick={() => (canAdjust ? void openEditor() : fileInput?.click())}
      ondragenter={(e) => onDrag(e, true)}
      ondragover={(e) => onDrag(e, true)}
      ondragleave={(e) => onDrag(e, false)}
      ondrop={(e) => {
        onDrag(e, false);
        void acceptFile(e.dataTransfer?.files?.[0]);
      }}
    >
      {#if live}
        <img class="live" src={live.src} alt="Your avatar" style={live.style} data-testid={`${testid}-live`} />
      {:else if shownSrc}
        <img src={shownSrc} alt="Your avatar" data-testid={imgTestid} />
      {:else}
        <span class="initial" data-testid={fallbackTestid}>{initial}</span>
      {/if}
      <span class="hover" aria-hidden="true">{dropping ? "Drop" : canAdjust ? "Adjust" : hasPhoto ? "Change" : "Choose"}</span>
    </button>
    </span>
  {:else}
    <span class="avatar static" style={`--ppf-size:${size}px`}>
      {#if shownSrc}
        <img src={shownSrc} alt="Your avatar" data-testid={imgTestid} />
      {:else}
        <span class="initial" data-testid={fallbackTestid}>{initial}</span>
      {/if}
    </span>
  {/if}

  {#snippet statusLine()}
    <span
      class="status"
      class:ok={status === "saved" || status === "crop-saved"}
      class:err={status === "error"}
      role="status"
      data-testid={`${testid}-status`}
    >
      {#if status === "saving"}<span class="spin" aria-hidden="true"></span>Saving…
      {:else if status === "saved"}Photo updated{#if previous}&nbsp;·&nbsp;<button
            type="button"
            class="link"
            data-testid={`${testid}-undo`}
            onclick={() => void undo()}>Undo</button
          >{/if}
      {:else if status === "crop-saved"}Saved
      {:else if status === "error"}{errorText}
      {:else if status === "retry"}Couldn't save&nbsp;·&nbsp;<button
          type="button"
          class="link"
          data-testid={`${testid}-retry`}
          onclick={retrySave}>Retry</button
        >
      {/if}
    </span>
  {/snippet}

  {#snippet adjustButton()}
    {#if canAdjust && !editing}
      <button
        type="button"
        class="chip"
        class:big={buttonStyle === "button"}
        data-testid={`${testid}-adjust`}
        disabled={busy || disabled}
        onclick={() => void openEditor()}>Adjust</button
      >
    {/if}
  {/snippet}

  {#snippet changeButton()}
    <button
      type="button"
      class="chip"
      class:big={buttonStyle === "button"}
      data-testid={changeTestid}
      disabled={busy || disabled}
      onclick={() => fileInput?.click()}
      ><RailIcon name="upload" />
      {changeLabel}</button
    >
  {/snippet}

  {#if layout === "stacked"}
    <div class="stack">
      {#if editable}
        <div class="actions stacked">
          {@render changeButton()}
          {@render adjustButton()}
          {@render statusLine()}
        </div>
      {/if}
      {#if meta}<div class="meta">{@render meta()}</div>{/if}
    </div>
  {:else}
    {#if meta}<div class="meta">{@render meta()}</div>{/if}
    {#if editable}
      <div class="actions">
        {@render statusLine()}
        {@render adjustButton()}
        {@render changeButton()}
      </div>
    {/if}
  {/if}

  {#if editable}
    <input
      bind:this={fileInput}
      class="file"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      data-testid={inputTestid}
      onchange={(e) => {
        const input = e.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        input.value = "";
        void acceptFile(file);
      }}
    />
  {/if}

  {#if editing && session}
    <div class="full editor">
      <PhotoCropEditor
        source={session.source}
        crop={session.crop}
        busy={editBusy || status === "saving"}
        ondone={(crop) => void finishEdit(crop)}
        oncancel={() => (editing = false)}
        onchange={(crop) => (liveCrop = crop)}
      />
    </div>
  {:else if offer}
    <div class="full offer" class:done={offer.state === "done"} data-testid={`${testid}-offer`}>
      <span class="swap" aria-hidden="true">
        {#if offer.otherThumb}
          <img class="thumb" src={offer.otherThumb} alt="" />
        {:else}
          <span class="thumb empty">{initial}</span>
        {/if}
        <svg width="12" height="12" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        <img class="thumb" src={offer.thumb} alt="" />
      </span>
      <span class="offer-text" data-testid={`${testid}-offer-text`}>{offerText}</span>
      {#if offer.state !== "done"}
        <button
          type="button"
          class="chip"
          data-testid={`${testid}-offer-action`}
          disabled={offer.state === "busy"}
          onclick={() => void applyOffer()}>{offer.state === "busy" ? "Updating…" : offerAction}</button
        >
        <button
          type="button"
          class="link dim"
          data-testid={`${testid}-offer-dismiss`}
          onclick={() => (offer = null)}>Not now</button
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  .ppf {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    width: 100%;
  }

  /* Holds the photo and its HQ glow. */
  .avatar-wrap {
    position: relative;
    flex: none;
    width: var(--ppf-size);
    height: var(--ppf-size);
  }

  .avatar {
    position: relative;
    flex: none;
    display: grid;
    place-items: center;
    width: var(--ppf-size);
    height: var(--ppf-size);
    padding: 0;
    border: 0;
    border-radius: 50%;
    overflow: hidden;
    background: var(--ice-ink, var(--v4-control-faint, #2a2a2e));
    color: var(--badge-fg, var(--v4-text-1, #fafafa));
    font: inherit;
    cursor: pointer;
  }

  .avatar.static {
    cursor: default;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .avatar img.live {
    position: absolute;
    left: 50%;
    top: 50%;
    max-width: none;
    object-fit: fill;
  }

  .initial {
    font-size: calc(var(--ppf-size) * 0.4);
    font-weight: 600;
  }

  .hover {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.15s ease-out;
  }

  .avatar:not(:disabled):hover .hover,
  .avatar.drop .hover {
    opacity: 1;
  }

  .avatar.drop {
    box-shadow: 0 0 0 2px var(--v4-text-1, #fafafa);
  }

  .avatar.saving::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: var(--v4-text-1, #fafafa);
    animation: ppf-spin 0.9s linear infinite;
  }

  .avatar:focus-visible,
  .chip:focus-visible,
  .link:focus-visible {
    outline: 1.5px solid var(--v4-focus-ring, #6366f1);
    outline-offset: 2px;
  }

  .meta {
    flex: 1 1 auto;
    min-width: 0;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .actions.stacked {
    margin-left: 0;
  }

  /* The page's regular button (Public profile), not the small Settings chip. */
  .chip.big {
    height: var(--hq-btn-h, 30px);
    padding: 0 var(--v4-space-3, 12px);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button, 6px);
    background: var(--v4-raised);
    color: var(--v4-text-1);
    font-size: var(--text-base, 13px);
  }

  .chip.big:hover:not(:disabled) {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 18px;
    color: var(--t2, var(--v4-text-2));
    font-size: 12px;
  }

  .status.ok {
    color: var(--ok, var(--v4-ok, #34c759));
  }

  .status.err {
    color: var(--t3, var(--v4-text-3, rgb(250 250 250 / 0.4)));
  }

  .spin {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.5px solid var(--v4-text-3, rgb(250 250 250 / 0.36));
    border-top-color: var(--v4-text-1, #fafafa);
    animation: ppf-spin 0.8s linear infinite;
  }

  @keyframes ppf-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--line2, var(--v4-control-border));
    border-radius: 6px;
    background: none;
    color: var(--t2, var(--v4-text-2));
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .chip:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    font-size: 12px;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .link.dim {
    color: var(--v4-text-3, rgb(250 250 250 / 0.4));
    text-decoration: none;
  }

  .link.dim:hover {
    color: var(--t2, var(--v4-text-2));
  }

  .file {
    display: none;
  }

  .full {
    flex-basis: 100%;
    margin-left: calc(var(--ppf-size, 48px) + 14px);
  }

  .editor {
    padding: 8px 0 4px;
  }

  .offer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--line, var(--v4-hairline));
    border-radius: 8px;
    animation: ppf-rise 0.2s ease-out;
  }

  .swap {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    color: var(--v4-text-3, rgb(250 250 250 / 0.4));
  }

  .swap svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  .thumb {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }

  .thumb.empty {
    display: grid;
    place-items: center;
    border: 1px dashed var(--line2, var(--v4-control-border));
    color: var(--t2, var(--v4-text-2));
    font-size: 9px;
    font-weight: 600;
  }

  .offer-text {
    flex: 1 1 auto;
    color: var(--t2, var(--v4-text-2));
    font-size: 12px;
  }

  .offer.done .offer-text {
    color: var(--ok, var(--v4-ok, #34c759));
  }

  @keyframes ppf-rise {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .offer,
    .hover {
      animation: none;
      transition: none;
    }
    .spin,
    .avatar.saving::after {
      animation-duration: 2.4s;
    }
  }
</style>
