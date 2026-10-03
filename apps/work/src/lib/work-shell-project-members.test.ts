import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

describe("WorkShell project member callback", () => {
  it("returns the add result to its caller", async () => {
    const source = await readFile(new URL("./WorkShell.svelte", import.meta.url), "utf8");
    const match = source.match(
      /const addProjectMember = async \(row: ConversationRow, personUid: string\): Promise<ProjectMemberAddResult> => \{([\s\S]*?)\n  \};/,
    );

    expect(match, "WorkShell must keep the project member callback").not.toBeNull();
    const mockedAdd = vi.fn().mockResolvedValue("added");
    const makeCallback = new Function(
      "addLiveProjectMember",
      "workFetch",
      `return async (row, personUid) => {${match?.[1] ?? ""}\n};`,
    ) as (
      mockedAdd: typeof mockedAdd,
      workFetch: unknown,
    ) => (row: { companyUid: string; projectId: string }, personUid: string) => Promise<string>;
    const callback = makeCallback(mockedAdd, {});

    await expect(callback({ companyUid: "cmp_test", projectId: "project_test" }, "prs_test"))
      .resolves.toBe("added");
    expect(mockedAdd).toHaveBeenCalledWith("cmp_test", "project_test", "prs_test", {});
  });
});
