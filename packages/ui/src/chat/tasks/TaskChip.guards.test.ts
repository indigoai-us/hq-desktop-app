import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The generated mark is inlined with {@html}. That is safe only because the
 * comment's rule holds: task title, id, and status are never interpolated
 * into the markup. The compiled DOM does not keep the comment.
 */
const source = readFileSync(
  resolve(process.cwd(), "src/chat/tasks/TaskChip.svelte"),
  "utf8",
);

describe("TaskChip mark safety", () => {
  it("documents why the generated mark is safe to inline", () => {
    expect(source).toContain("{@html mark.svg}");
    expect(source).toMatch(/No task field/i);
  });
});
