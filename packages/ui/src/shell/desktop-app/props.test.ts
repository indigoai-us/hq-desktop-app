import type { ComponentProps } from "svelte";
import { describe, expectTypeOf, it } from "vitest";
import type { PlatformAdapter } from "@hq/platform";

import type { ChatSidebarApi, NotificationsApi } from "../../chat/chat-api.js";
import type DesktopApp from "../DesktopApp.svelte";
import type { DesktopAppProps } from "./props.js";

// Type-level checks: svelte-check (and `vitest --typecheck`) read these.
describe("DesktopAppProps", () => {
  it("is exactly the prop contract DesktopApp takes", () => {
    expectTypeOf<ComponentProps<typeof DesktopApp>>().toEqualTypeOf<DesktopAppProps>();
  });

  it("requires only the adapter, the sidebar API and the notifications API", () => {
    type Required = {
      [K in keyof DesktopAppProps as undefined extends DesktopAppProps[K] ? never : K]: DesktopAppProps[K];
    };
    expectTypeOf<keyof Required>().toEqualTypeOf<"adapter" | "sidebarApi" | "notificationsApi">();
    expectTypeOf<DesktopAppProps["adapter"]>().toEqualTypeOf<PlatformAdapter>();
    expectTypeOf<DesktopAppProps["sidebarApi"]>().toEqualTypeOf<ChatSidebarApi>();
    expectTypeOf<DesktopAppProps["notificationsApi"]>().toEqualTypeOf<NotificationsApi>();
  });
});
