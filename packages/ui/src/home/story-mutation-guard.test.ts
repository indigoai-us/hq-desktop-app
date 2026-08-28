import { describe, expect, it } from "vitest";
import { createStoryMutationGuard } from "./story-mutation-guard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("story mutation selection guard", () => {
  it("ignores a deferred result after the panel selects another story", async () => {
    const guard = createStoryMutationGuard();
    const target = guard.capture(
      "US-001",
      "companies/indigo/projects/a/prd.json",
    );
    const result = deferred<boolean>();
    const applied: string[] = [];

    const completion = result.promise.then((passes) => {
      if (
        guard.isCurrent(
          target,
          "US-002",
          "companies/indigo/projects/b/prd.json",
        )
      ) {
        applied.push(`${target.storyId}:${passes}`);
      }
    });

    guard.invalidate();
    result.resolve(true);
    await completion;

    expect(applied).toEqual([]);
  });

  it("accepts the latest result for the exact story and PRD path", async () => {
    const guard = createStoryMutationGuard();
    const path = "companies/indigo/projects/a/prd.json";
    const target = guard.capture("US-001", path);
    const result = deferred<boolean>();

    const completion = result.promise.then((passes) => ({
      passes,
      current: guard.isCurrent(target, "US-001", path),
    }));
    result.resolve(true);

    await expect(completion).resolves.toEqual({ passes: true, current: true });
  });
});
