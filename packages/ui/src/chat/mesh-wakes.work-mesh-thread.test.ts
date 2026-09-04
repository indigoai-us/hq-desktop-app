import { describe, expect, it } from "vitest";

import { routeMeshReconcile } from "./mesh-wakes";

function recordingBus() {
  const events: Array<{ name: string; payload: unknown }> = [];
  return {
    events,
    bus: {
      emit: (name: string, payload: unknown) => {
        events.push({ name, payload });
      },
      on: () => () => {},
    } as never,
  };
}

describe("routeMeshReconcile — work-mesh thread wakes", () => {
  it("emits work-mesh:thread for a thread reconcile", () => {
    const { bus, events } = recordingBus();
    const kind = routeMeshReconcile(
      { resource: "thread:cmp_acme:3e5d9219-4ab2" } as never,
      bus,
    );
    expect(kind).toBe("directory");
    expect(events[0]).toEqual({
      name: "work-mesh:thread",
      payload: { companyUid: "cmp_acme", threadId: "3e5d9219-4ab2" },
    });
  });

  it("still nudges the directory after the work-mesh wake", () => {
    const { bus, events } = recordingBus();
    routeMeshReconcile({ resource: "thread:cmp_acme:t1" } as never, bus);
    expect(events.map((e) => e.name)).toEqual([
      "work-mesh:thread",
      "channel:unread-changed",
    ]);
  });

  it("does not emit work-mesh:thread for other resources", () => {
    const { bus, events } = recordingBus();
    routeMeshReconcile({ resource: "channels:cmp_acme" } as never, bus);
    expect(events.map((e) => e.name)).toEqual(["channel:unread-changed"]);
  });

  it("ignores a malformed thread resource instead of emitting a blank wake", () => {
    const { bus, events } = recordingBus();
    routeMeshReconcile({ resource: "thread:cmp_acme:" } as never, bus);
    expect(events.map((e) => e.name)).toEqual(["channel:unread-changed"]);
  });
});
