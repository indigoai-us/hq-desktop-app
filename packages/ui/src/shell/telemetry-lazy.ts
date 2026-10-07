/**
 * The only door into the Telemetry chunk. Call when the Telemetry route
 * mounts. The module promise is memoized so later mounts reuse the chunk.
 * TODO US-006: the rail sidepane host owns page chrome; this door stays the
 * only import of packages/ui/src/telemetry.
 */
type TelemetryModule = typeof import("../telemetry/index.js");

let pending: Promise<TelemetryModule> | null = null;

export function loadTelemetry(): Promise<TelemetryModule> {
  pending ??= import("../telemetry/index.js").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
