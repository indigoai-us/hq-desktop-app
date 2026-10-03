/**
 * The only door into the Activity token chart chunk.
 */
type ChartModule = typeof import("./TokenDayStrip.svelte");

let pending: Promise<ChartModule> | null = null;

export function loadTokenDayStrip(): Promise<ChartModule> {
  pending ??= import("./TokenDayStrip.svelte").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
