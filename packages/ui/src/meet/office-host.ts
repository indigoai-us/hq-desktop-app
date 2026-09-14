/**
 * The native seams the shared Office surface needs but must never own (US-018).
 *
 * `@hq/ui` is host-agnostic: it cannot import `@tauri-apps/*`, cannot read a
 * bundled build artifact, and cannot open an OS window. Everything in that
 * category is handed down from the host (Sync → WorkShell → DesktopApp →
 * OfficePanel) as this one object, so there is a single place to look for
 * "what does the desktop do that the browser cannot".
 */

/** Ids only. A call-window target carries no token, key, secret or credential. */
export interface OfficeCallTarget {
  /** Host-stable identity for the window: company:room:call:epoch. */
  sessionId: string;
  companyUid: string;
  roomId: string;
  callId: string;
  epoch: number;
  self: { personUid: string; deviceId: string };
  /**
   * Present only when this admission rides an accepted knock — that is, only
   * on the KNOCKER's side, entering the TARGET's room.
   *
   * `capabilityId` is the id of a short-lived admission GRANT the server minted
   * for this one admission: not a token, not a credential, and worth nothing to
   * anyone else. It expires shortly after acceptance, so a window opened with
   * it must be opened at once, or not at all.
   */
  knock?: { knockId: string; capabilityId: string };
}

export interface OfficeCallsHost {
  /**
   * The build-time US-011 service-evidence receipt handed to
   * `adapter.calls.preflight`. Opaque here on purpose — only
   * `validateServiceEvidence` decides whether it counts.
   */
  serviceEvidence: unknown;
  /**
   * Explicit staleness window for THAT receipt. A bundled receipt ages with the
   * build, not with the session, so the host sets its own bound rather than
   * inheriting the per-session default.
   */
  evidenceMaxAgeMs?: number;
  /** Open (or focus) the native call window for a room. */
  openCallWindow: (target: OfficeCallTarget) => Promise<void>;
  /** This device's stable fingerprint, used only as an id inside the target. */
  resolveDeviceId?: () => Promise<string>;
}
