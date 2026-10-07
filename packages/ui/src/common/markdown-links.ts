/**
 * Link handling for rendered Markdown documents (QA-094).
 *
 * A rendered document's anchors keep their source hrefs, so a relative link
 * such as `references.md` would resolve against the webview origin
 * (hq-ui://localhost/references.md) and go nowhere. The handler resolves it
 * instead:
 *   * relative paths resolve against the current file's folder and open that
 *     file through `onopenfile`
 *   * http(s)/mailto links leave through the host opener
 *   * `#heading` anchors scroll inside the rendered document
 */
import { closestHrefAnchor, externalHref, openExternalHref } from "./external-links.js";

export type MarkdownLinkTarget =
  | { kind: "file"; path: string }
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "ignore" };

/** Join `href` onto the folder of `currentPath`, resolving `.` and `..`. */
export function resolveRelativePath(currentPath: string, href: string): string | null {
  const base = currentPath.split("/").slice(0, -1);
  const parts = href.startsWith("/") ? [] : base;
  for (const segment of href.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.length > 0 ? parts.join("/") : null;
}

export function resolveMarkdownLink(raw: string, currentPath: string): MarkdownLinkTarget {
  const href = raw.trim();
  if (href === "") return { kind: "ignore" };
  if (href.startsWith("#")) return { kind: "anchor", id: decodeSafe(href.slice(1)) };
  const url = externalHref(href);
  if (url) return { kind: "external", url };
  // Any other scheme (javascript:, file:, hq-ui:) and protocol-relative URLs stay inert.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^(?:\/\/|\\\\)/.test(href)) return { kind: "ignore" };
  const pathPart = decodeSafe(href.split(/[?#]/)[0] ?? "");
  if (pathPart === "") return { kind: "ignore" };
  const path = resolveRelativePath(currentPath, pathPart);
  return path ? { kind: "file", path } : { kind: "ignore" };
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** GitHub-style heading slug: lowercase, punctuation dropped, spaces to dashes. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function scrollToAnchor(root: Element, id: string): void {
  const wanted = id.toLowerCase();
  const byId = root.querySelector(`[id="${CSS.escape(id)}"]`);
  const heading =
    byId ??
    Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6")).find(
      (el) => headingSlug(el.textContent ?? "") === wanted,
    );
  heading?.scrollIntoView({ block: "start" });
}

export interface MarkdownLinkOptions {
  /** HQ-relative path of the document being rendered. */
  currentPath: string;
  /** Open a resolved project file. */
  onopenfile?: (path: string) => void;
  /** Host URL opener; falls back to the shell's registered opener. */
  onopenurl?: (url: string) => void;
}

/** Handle a click inside a rendered Markdown root. Returns true when consumed. */
export function handleMarkdownLinkClick(event: MouseEvent, opts: MarkdownLinkOptions): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  const root = event.currentTarget;
  if (!(root instanceof Element)) return false;
  const anchor = closestHrefAnchor(event.target);
  if (!anchor || !root.contains(anchor)) return false;
  const target = resolveMarkdownLink(anchor.getAttribute("href") ?? "", opts.currentPath);
  event.preventDefault();
  event.stopPropagation();
  if (target.kind === "external") openExternalHref(target.url, opts.onopenurl);
  else if (target.kind === "anchor") scrollToAnchor(root, target.id);
  else if (target.kind === "file") opts.onopenfile?.(target.path);
  return true;
}

/** Svelte action: `<article use:markdownLinks={{ currentPath, onopenfile }}>`. */
export function markdownLinks(node: HTMLElement, initial: MarkdownLinkOptions) {
  let opts = initial;
  const onclick = (event: MouseEvent) => {
    handleMarkdownLinkClick(event, opts);
  };
  node.addEventListener("click", onclick);
  return {
    update(next: MarkdownLinkOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener("click", onclick);
    },
  };
}
