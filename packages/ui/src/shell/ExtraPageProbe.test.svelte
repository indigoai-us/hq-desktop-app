<script lang="ts">
  /**
   * Test-only stand-in for a host-registered `extraPages` component.
   *
   * It implements exactly the contract `DesktopApp`'s `extraPages` seam
   * promises a host — an optional opaque `param` in, an `onnavigate` callback
   * out — so `DesktopApp.extra-pages.test.ts` can prove the seam without
   * pulling a host page (and its platform SDK) into `packages/ui`.
   */
  interface Props {
    param?: string | null;
    onnavigate?: (param: string | null) => void;
  }

  let { param = null, onnavigate }: Props = $props();
</script>

<div data-testid="extra-page-probe" data-param={param ?? ""}>
  <span data-testid="extra-page-probe-param">{param ?? "none"}</span>
  <button
    type="button"
    data-testid="extra-page-probe-navigate"
    onclick={() => onnavigate?.("chosen-by-page")}
  >
    Open one
  </button>
</div>
