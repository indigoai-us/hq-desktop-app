/** The only door into the Daily Brief chunk. Memoized so later mounts reuse it. */
type BriefModule = typeof import("../brief/index.js");

let pending: Promise<BriefModule> | null = null;

export function loadBrief(): Promise<BriefModule> {
  pending ??= import("../brief/index.js").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
