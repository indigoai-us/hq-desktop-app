import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { projectIdFromDirectoryRow } from "./live-sidebar";

type AddProjectMember = (
  companyUid: string,
  projectId: string,
  personUid: string,
  workFetch: unknown,
) => Promise<"added" | "not-enabled">;

type ProjectRow = {
  companyUid: string;
  projectId?: string | null;
  channelId?: string | null;
  title?: string;
};

describe("WorkShell project member callback", () => {
  it("returns the add result and resolves legacy project ids through the shared helper", async () => {
    const source = await readFile(new URL("./WorkShell.svelte", import.meta.url), "utf8");
    const match = source.match(
      /const addProjectMember = async \(row: ConversationRow, personUid: string\): Promise<ProjectMemberAddResult> => \{([\s\S]*?)\n  \};/,
    );

    expect(match, "WorkShell must keep the project member callback").not.toBeNull();
    const mockedAdd: AddProjectMember = vi.fn(async () => "added");
    const makeCallback = new Function(
      "addLiveProjectMember",
      "workFetch",
      "projectIdFor",
      `return async (row, personUid) => {${match?.[1] ?? ""}\n};`,
    ) as (
      addProjectMember: AddProjectMember,
      workFetch: unknown,
      projectIdFor: (row: ProjectRow) => string | null,
    ) => (row: ProjectRow, personUid: string) => Promise<"added" | "not-enabled">;
    const callback = makeCallback(
      mockedAdd,
      {},
      (row) => projectIdFromDirectoryRow(row),
    );

    await expect(callback({ companyUid: "cmp_test", channelId: "legacy-project" }, "prs_test"))
      .resolves.toBe("added");
    expect(mockedAdd).toHaveBeenCalledWith("cmp_test", "legacy-project", "prs_test", {});
  });
});
