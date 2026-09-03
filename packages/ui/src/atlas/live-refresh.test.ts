import { describe, expect, it, vi } from "vitest";
import { bindLiveRefresh, requestLiveRefresh } from "./live-refresh.js";

describe("live-refresh seam", () => {
  it("forwards a single open refresh to the bound MeshClient hook", () => {
    const refresh = vi.fn();
    const unbind = bindLiveRefresh(refresh);
    requestLiveRefresh("cmp_indigo");
    expect(refresh).toHaveBeenCalledWith("cmp_indigo");
    unbind();
    requestLiveRefresh("cmp_indigo");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores blank company uids", () => {
    const refresh = vi.fn();
    const unbind = bindLiveRefresh(refresh);
    requestLiveRefresh("  ");
    expect(refresh).not.toHaveBeenCalled();
    unbind();
  });
});
