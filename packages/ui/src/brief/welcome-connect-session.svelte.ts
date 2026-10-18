/**
 * The welcome report's connect session: everything "Connect your AI apps"
 * is doing, held by its owner (the shell) instead of by the card. The card
 * remounts when the report flips from loading or held to ready (it moves
 * into the brief body), and a later Daily Brief visit mounts it again; the
 * session keeps the launch scan, the company's apps, the runs in flight, the
 * Connect waiting on a new company and the per-company memory across those
 * remounts. A sign-in is only cancelled when the company changes or the
 * owner disposes the session.
 */
import type { FoundWorkApps } from "@hq/platform";
import type { AppRun, AppTile, ConnectedChip } from "../chat/first-run/your-apps.js";
import type { YourAppsHost, YourAppsLoad } from "../chat/first-run/your-apps-host.js";
import type { WelcomeConnectMemory } from "./welcome-ai-apps.js";

/** How long a Connect waits for the company the new-company step made to become the report's company. */
export const NEW_COMPANY_WAIT_MS = 15_000;

/** The existing "Didn't connect" state (YOUR_APPS_COPY.failed), with Try again. */
const DIDNT_CONNECT: AppRun = { state: "failed", reason: "", retry: true };

const LOAD_THREW: YourAppsLoad = {
  catalog: null,
  connections: [],
  installations: {},
  canManage: false,
  problem: { reason: "Couldn't load your apps. Try again.", retry: true },
};

export class WelcomeConnectSession {
  /** The launch scan (names only), once it ran; shared by both groups. */
  scan = $state.raw<FoundWorkApps | null>(null);
  /** The company's catalog matches and connections; null while loading or with no company. */
  load = $state.raw<YourAppsLoad | null>(null);
  runs = $state.raw<Record<string, AppRun>>({});
  undoProblem = $state<string | null>(null);
  /** The app whose Connect is waiting on a new company, and that company once it exists. */
  pending = $state<string | null>(null);
  pendingUid = $state<string | null>(null);
  /** With no company: the found app whose wait ran out; its row says it didn't connect. */
  waitFailed = $state<string | null>(null);

  /** undefined until the first setCompany, so the first one always loads. */
  #company: string | null | undefined = undefined;
  #host: YourAppsHost | null = null;
  /** Bumped per load: an answer for an older company or an older Retry is dropped. */
  #gen = 0;
  #loading = false;
  #abort = new AbortController();
  #disposed = false;
  #scanStarted = false;
  #waitTimer: ReturnType<typeof setTimeout> | undefined;
  #memory = new Map<string, WelcomeConnectMemory>();

  get company(): string | null {
    return this.#company ?? null;
  }

  /** What the section did for one company: the auto-connect ran, the apps the person undid. */
  memoryFor(uid: string): WelcomeConnectMemory {
    let mem = this.#memory.get(uid);
    if (!mem) this.#memory.set(uid, (mem = { autoRan: false, undone: new Set<string>() }));
    return mem;
  }

  /** Runs the launch scan once; a scan that threw runs again on the next mount. */
  detectOnce(detect: () => Promise<FoundWorkApps | null>): void {
    if (this.#scanStarted || this.#disposed) return;
    this.#scanStarted = true;
    void detect().then(
      (found) => {
        if (!this.#disposed) this.scan = found ?? null;
      },
      (err: unknown) => {
        this.#scanStarted = false;
        console.warn("[hq-desktop] welcome report app scan threw:", err);
      },
    );
  }

  /**
   * The report's company. The same company keeps everything (a remount);
   * a different one starts over with its own catalog, connections and runs.
   */
  setCompany(host: YourAppsHost, uid: string | null): void {
    this.#host = host;
    if (this.#disposed) return;
    // Same company (a remount, or the report switched before the sheet answered).
    // A matching Connect whose catalog has not arrived keeps its wait: stopping
    // the timer here left the row on Waiting for a hung catalog.
    if (uid === this.#company) {
      if (uid && this.pending && this.pendingUid === uid && !this.load) this.#armCatalogWait(this.pending, uid);
      return;
    }
    this.#company = uid;
    this.#gen += 1;
    this.#loading = false;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.load = null;
    this.runs = {};
    this.undoProblem = null;
    if (uid) this.waitFailed = null;
    if (this.pending && this.pendingUid) {
      if (uid === this.pendingUid) {
        // The company arrived. The wait now covers the catalog, not the sheet.
      } else if (uid) this.#waitRanOut();
    }
    if (uid) {
      this.#loadApps(uid);
      if (this.pending && this.pendingUid === uid) this.#armCatalogWait(this.pending, uid);
    }
  }

  #loadApps(uid: string): void {
    const host = this.#host;
    if (this.#loading || !host) return;
    this.#loading = true;
    const mine = ++this.#gen;
    void host.load(uid).then(
      (next) => {
        if (mine !== this.#gen) return;
        this.#loading = false;
        if (!this.#disposed) this.load = next;
      },
      (err: unknown) => {
        if (mine !== this.#gen) return;
        this.#loading = false;
        console.warn("[hq-desktop] welcome report apps load threw:", err);
        if (!this.#disposed) this.load = LOAD_THREW;
      },
    );
  }

  reload(): void {
    const uid = this.company;
    if (!uid) return;
    this.undoProblem = null;
    this.load = null;
    this.#loading = false;
    this.memoryFor(uid).autoRan = false;
    this.#loadApps(uid);
  }

  /**
   * Try again after a hung catalog, once the company exists. Reloads the
   * catalog instead of opening the new-company sheet a second time.
   */
  retryCatalog(domain: string): void {
    const uid = this.company;
    if (!uid || this.pending) return;
    this.waitFailed = null;
    this.pending = domain;
    this.pendingUid = uid;
    this.setRun(domain, { state: "idle" });
    this.#armCatalogWait(domain, uid);
    this.reload();
  }

  setRun(domain: string, run: AppRun): void {
    this.runs = { ...this.runs, [domain]: run };
  }

  /** Writes a result only while it still belongs to the company it started for. */
  #settle(mine: number, write: () => void): void {
    if (!this.#disposed && mine === this.#gen) write();
  }

  connect(tile: AppTile): void {
    const uid = this.company;
    const host = this.#host;
    if (!uid || !host) return;
    const mine = this.#gen;
    this.setRun(tile.domain, { state: "connecting", via: tile.action === "install" ? "install" : "browser" });
    void host.connect(uid, tile, this.#abort.signal).then((res) =>
      this.#settle(mine, () => {
        if (res.ok) this.setRun(tile.domain, { state: "connected", how: "person", connectionId: res.connectionId });
        else this.setRun(tile.domain, res.reason ? { state: "failed", reason: res.reason, retry: res.retry } : { state: "idle" });
      }),
    );
  }

  setup(tile: AppTile): void {
    const uid = this.company;
    const host = this.#host;
    if (!uid || !host) return;
    const mine = this.#gen;
    this.setRun(tile.domain, { state: "checking-docs" });
    void host.setup(uid, tile, this.#abort.signal).then((res) =>
      this.#settle(mine, () => {
        if (res.ok) this.setRun(tile.domain, { state: "connected", how: "person", connectionId: res.connectionId });
        else if (res.unsupported) this.setRun(tile.domain, { state: "unsupported" });
        else this.setRun(tile.domain, res.reason ? { state: "failed", reason: res.reason, retry: res.retry } : { state: "idle" });
      }),
    );
  }

  /** Connects the planned no-sign-in apps, once per company. */
  autoConnect(items: readonly { domain: string; entryId: string; name: string }[]): void {
    const uid = this.company;
    const host = this.#host;
    if (!uid || !host) return;
    const mine = this.#gen;
    for (const item of items) {
      this.setRun(item.domain, { state: "connecting", via: "install" });
      void host.autoConnect(uid, item.entryId, item.name).then((res) =>
        this.#settle(mine, () => {
          if (res.ok) this.setRun(item.domain, { state: "connected", how: "auto", connectionId: res.connectionId, installationId: res.installationId });
          else this.setRun(item.domain, res.reason ? { state: "failed", reason: res.reason, retry: res.retry } : { state: "idle" });
        }),
      );
    }
  }

  undo(chip: ConnectedChip): void {
    const uid = this.company;
    const host = this.#host;
    const installationId = chip.installationId;
    if (!uid || !host || !installationId) return;
    const before = this.runs[chip.domain] ?? { state: "idle" };
    const mine = this.#gen;
    this.undoProblem = null;
    this.setRun(chip.domain, { state: "undoing", connectionId: chip.connectionId, installationId });
    void host.undo(uid, installationId).then((res) =>
      this.#settle(mine, () => {
        if (res.ok) {
          this.memoryFor(uid).undone.add(chip.domain);
          const load = this.load;
          if (load && chip.connectionId) this.load = { ...load, connections: load.connections.filter((c) => c.id !== chip.connectionId) };
          this.setRun(chip.domain, { state: "idle" });
        } else {
          this.setRun(chip.domain, before.state === "idle" ? { state: "connected", how: "auto", connectionId: chip.connectionId, installationId } : before);
          this.undoProblem = res.reason;
        }
      }),
    );
  }

  /**
   * No company yet: opens the new-company flow for this app. Once it answers
   * with a company, the Connect waits up to NEW_COMPANY_WAIT_MS for it to be
   * the report's company; the card runs the Connect when its apps load.
   */
  async connectAfterNewCompany(domain: string, open: () => Promise<string | null>): Promise<void> {
    if (this.pending || this.#disposed) return;
    this.pending = domain;
    this.waitFailed = null;
    let uid: string | null = null;
    try {
      uid = await open();
    } catch (err) {
      console.warn("[hq-desktop] welcome report new company threw:", err);
    }
    if (this.#disposed || this.pending !== domain) return;
    if (!uid) {
      this.pending = null;
      return;
    }
    this.pendingUid = uid;
    if (this.company && this.company !== uid) {
      this.#waitRanOut();
      return;
    }
    // Company already matches, or it has not switched yet. Either way the
    // wait covers a catalog that never arrives.
    this.#armCatalogWait(domain, uid);
  }

  /** The card ran (or dropped) the Connect that waited for the new company. */
  takePending(uid: string): string | null {
    if (!this.pending || this.pendingUid !== uid) return null;
    const domain = this.pending;
    this.#clearPending();
    return domain;
  }

  /**
   * Restart the bounded wait. It ends when the catalog is in and the card
   * can connect, or when the wait runs out, including a hung catalog.
   */
  #armCatalogWait(domain: string, uid: string): void {
    this.#stopWaitTimer();
    this.#waitTimer = setTimeout(() => {
      this.#waitTimer = undefined;
      if (this.pending !== domain || this.pendingUid !== uid) return;
      if (this.company === uid && this.load) return;
      this.#waitRanOut();
    }, NEW_COMPANY_WAIT_MS);
  }

  /** The Connect that waited never reached a loaded catalog: its row says it didn't connect, with Try again. */
  #waitRanOut(): void {
    const domain = this.pending;
    this.#clearPending();
    if (!domain) return;
    if (this.company) {
      this.setRun(domain, DIDNT_CONNECT);
      if (!this.load) this.waitFailed = domain;
    } else this.waitFailed = domain;
  }

  #clearPending(): void {
    this.#stopWaitTimer();
    this.pending = null;
    this.pendingUid = null;
  }

  #stopWaitTimer(): void {
    clearTimeout(this.#waitTimer);
    this.#waitTimer = undefined;
  }

  /** The owner is gone: cancel what is running and drop every later answer. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#gen += 1;
    this.#abort.abort();
    this.#stopWaitTimer();
  }
}
