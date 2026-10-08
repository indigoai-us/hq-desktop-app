/**
 * The desktop host's side of the context scan, as the first-run step sees it:
 * listen for `IMPORT_SCAN_EVENT` lines carrying this scan's id, start the scan
 * through the adapter, and resolve with how it ended. Null when the host has
 * no scan command or no event bus (the web build), so the flow leaves the
 * step out.
 */

import { IMPORT_SCAN_EVENT, type ContextImportApi } from "@hq/platform";

import type { ImportScanEnd, ImportScanEndStatus, ImportScanHost } from "./import-runner.js";

export interface ImportScanBus {
  listen(event: string, handler: (event: { payload?: unknown }) => void): Promise<() => void>;
}

const STATUSES: readonly ImportScanEndStatus[] = ["done", "failed", "cancelled", "timeout", "unavailable"];

/**
 * How long to keep listening after the command answers "done": the last
 * lines are emitted before it answers but can be delivered just after.
 */
export const IMPORT_TAIL_GRACE_MS = 400;

export function createImportScanHost(
  api: ContextImportApi | null | undefined,
  bus: ImportScanBus | null | undefined,
  opts: { graceMs?: number; wait?: (ms: number) => Promise<void> } = {},
): ImportScanHost | null {
  if (!api || !bus) return null;
  const graceMs = opts.graceMs ?? IMPORT_TAIL_GRACE_MS;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async run(scanId, onevent): Promise<ImportScanEnd> {
      let unlisten: (() => void) | null = null;
      try {
        unlisten = await bus.listen(IMPORT_SCAN_EVENT, (e) => {
          const payload = e.payload as { scanId?: unknown; event?: unknown } | null | undefined;
          if (payload && payload.scanId === scanId) onevent(payload.event);
        });
      } catch {
        return { status: "failed" };
      }
      try {
        const result = await api.scanStart(scanId);
        if (!result.ok) return { status: "failed" };
        const raw = (result.value as { status?: unknown } | null)?.status;
        const status = STATUSES.find((s) => s === raw) ?? "failed";
        if (status === "done" && graceMs > 0) await wait(graceMs);
        return { status };
      } catch {
        return { status: "failed" };
      } finally {
        try {
          unlisten?.();
        } catch {
          // The listener is gone already.
        }
      }
    },
    cancel(scanId) {
      return api.scanCancel(scanId);
    },
  };
}
