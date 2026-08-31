/**
 * Host-owned lifecycle stream for package operations. The shared Installed
 * panel consumes this without importing Tauri, while desktop hosts bridge the
 * native `packages:*` events at this narrow boundary.
 */

import type {
  PackagesDone,
  PackagesProgress,
  PackagesView,
} from "./packages-model.js";

export type PackagesUnlistenFn = () => void;

export interface PackagesEvents {
  subscribe(handlers: {
    onProgress(progress: PackagesProgress): void;
    onComplete(done: PackagesDone): void;
    onError(done: PackagesDone): void;
    onUpdates(view: PackagesView): void;
  }): Promise<PackagesUnlistenFn>;
}
