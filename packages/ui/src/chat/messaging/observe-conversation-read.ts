/** Report read only after the newest content is visible in the focused window.
 * Retry failed writes on the next interaction; coalesce layout/scroll bursts.
 */
export function observeConversationRead(node: HTMLElement, initial: {
  key: string;
  onseen?: () => Promise<void>;
}) {
  let params = initial;
  let acknowledged = "";
  let pending = false;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const doc = node.ownerDocument;
  const win = doc.defaultView!;
  async function check() {
    timer = undefined;
    const { key, onseen } = params;
    if (destroyed || pending || !key || !onseen || key === acknowledged) return;
    if (doc.visibilityState !== "visible" || !doc.hasFocus()) return;
    if (!node.getClientRects().length || node.clientHeight <= 0) return;
    if (node.scrollHeight - node.scrollTop - node.clientHeight > 40) return;
    pending = true;
    try {
      await onseen();
      acknowledged = key;
    } catch (error) {
      console.error("conversation: mark read failed", error);
    } finally {
      pending = false;
      if (!destroyed && params.key !== key) schedule();
    }
  }
  function schedule() {
    if (destroyed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void check(), 100);
  }
  function blur() { acknowledged = ""; }
  function scroll() {
    if (node.scrollHeight - node.scrollTop - node.clientHeight > 40) acknowledged = "";
    schedule();
  }
  function visibility() {
    if (doc.visibilityState !== "visible") blur();
    schedule();
  }
  node.addEventListener("scroll", scroll);
  node.addEventListener("pointerdown", schedule);
  win.addEventListener("focus", schedule);
  win.addEventListener("blur", blur);
  doc.addEventListener("visibilitychange", visibility);
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  resize?.observe(node);
  schedule();
  return {
    update(next: typeof initial) { params = next; schedule(); },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      resize?.disconnect();
      node.removeEventListener("scroll", scroll);
      node.removeEventListener("pointerdown", schedule);
      win.removeEventListener("focus", schedule);
      win.removeEventListener("blur", blur);
      doc.removeEventListener("visibilitychange", visibility);
    },
  };
}
