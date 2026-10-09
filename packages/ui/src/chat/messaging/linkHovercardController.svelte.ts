// Hover/focus controller for link hovercards in chat messages.
//
// Message bodies are rendered HTML, so the host attaches these handlers to a
// wrapper element and they delegate to anchors marked `data-link-preview`
// (see relabelRawUrlLinks). The card is non-modal: it never moves focus,
// Escape closes it, and clicking the link still opens it.

import { linkPreview, type LinkPreview } from "../../common/linkPreview.js";
import { cachedPageTitle, onPageTitle, requestPageTitle } from "../../common/linkTitles.js";

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 180;

export interface LinkCardState {
  href: string;
  preview: LinkPreview;
  rect: { left: number; top: number; bottom: number; width: number };
  anchor: HTMLAnchorElement;
}

function previewAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[data-link-preview]");
  return anchor instanceof HTMLAnchorElement ? anchor : null;
}

export function insideLinkCard(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-link-card]") !== null;
}

export class LinkHovercardController {
  readonly id = `link-card-${Math.random().toString(36).slice(2, 10)}`;
  card = $state<LinkCardState | null>(null);
  /** Bumped whenever a fetched page title arrives; read it to re-render bodies. */
  titleVersion = $state(0);

  #openTimer: ReturnType<typeof setTimeout> | null = null;
  #closeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Call from a component `$effect`; returns the teardown. */
  connect(): () => void {
    const offTitle = onPageTitle(() => {
      this.titleVersion += 1;
    });
    const closeOnMove = () => {
      if (this.card) this.hide();
    };
    window.addEventListener("scroll", closeOnMove, true);
    window.addEventListener("resize", closeOnMove);
    return () => {
      offTitle();
      window.removeEventListener("scroll", closeOnMove, true);
      window.removeEventListener("resize", closeOnMove);
      this.#clearTimers();
    };
  }

  /** Page-title lookup for renderMessageBodyMarkdown; reads titleVersion so callers re-render. */
  pageTitles = (): ((href: string) => string | undefined) => {
    void this.titleVersion;
    return cachedPageTitle;
  };

  /** Fetched title for the open card, if any. */
  get pageTitle(): string | undefined {
    void this.titleVersion;
    return this.card ? cachedPageTitle(this.card.href) : undefined;
  }

  #clearTimers(): void {
    if (this.#openTimer) clearTimeout(this.#openTimer);
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#openTimer = null;
    this.#closeTimer = null;
  }

  show(anchor: HTMLAnchorElement): void {
    const href = anchor.getAttribute("href") ?? "";
    const preview = linkPreview(href);
    if (!preview) return;
    if (preview.wantsPageTitle) requestPageTitle(href);
    const box = anchor.getBoundingClientRect();
    if (this.card && this.card.anchor !== anchor) {
      this.card.anchor.removeAttribute("aria-describedby");
    }
    anchor.setAttribute("aria-describedby", this.id);
    this.card = {
      href,
      preview,
      anchor,
      rect: { left: box.left, top: box.top, bottom: box.bottom, width: box.width },
    };
  }

  hide = (): void => {
    this.#clearTimers();
    this.card?.anchor.removeAttribute("aria-describedby");
    this.card = null;
  };

  /** Keep the card open while the pointer is over it. */
  hold = (): void => {
    this.#clearTimers();
  };

  scheduleClose = (): void => {
    if (this.#openTimer) clearTimeout(this.#openTimer);
    this.#openTimer = null;
    if (!this.card) return;
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#closeTimer = setTimeout(this.hide, CLOSE_DELAY_MS);
  };

  onpointerover = (event: PointerEvent): void => {
    const anchor = previewAnchor(event.target);
    if (!anchor) return;
    this.#clearTimers();
    if (this.card?.anchor === anchor) return;
    this.#openTimer = setTimeout(() => this.show(anchor), OPEN_DELAY_MS);
  };

  onpointerout = (event: PointerEvent): void => {
    const anchor = previewAnchor(event.target);
    if (!anchor || anchor.contains(event.relatedTarget as Node | null)) return;
    this.scheduleClose();
  };

  onfocusin = (event: FocusEvent): void => {
    const anchor = previewAnchor(event.target);
    if (anchor) {
      this.#clearTimers();
      this.show(anchor);
    } else if (insideLinkCard(event.target)) {
      this.#clearTimers();
    }
  };

  onfocusout = (event: FocusEvent): void => {
    if (!previewAnchor(event.target) && !insideLinkCard(event.target)) return;
    const next = event.relatedTarget;
    if (insideLinkCard(next)) return;
    if (next instanceof Node && this.card?.anchor.contains(next)) return;
    this.scheduleClose();
  };

  /** Escape closes the card. Returns true when it handled the key. */
  onkeydown = (event: KeyboardEvent): boolean => {
    if (event.key !== "Escape" || !this.card) return false;
    event.preventDefault();
    event.stopPropagation();
    this.hide();
    return true;
  };
}

export async function copyLinkToClipboard(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Clipboard can be unavailable in some hosts; the card stays open.
  }
}
