import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelFileItemModel } from "@hq/ui";
import { hqProFetch } from "./hq-pro-client.js";
import {
  loadWebVaultFilePreview,
  metaFromProjectView,
  parseChannelMembers,
} from "./live-project.js";

vi.mock("./hq-pro-client.js", () => ({
  hqProFetch: vi.fn(),
}));

const previewFile: ChannelFileItemModel = {
  key: "projects/demo/brief.md",
  vaultPath: "projects/demo/brief.md",
  companyUid: "cmp_work",
  name: "brief.md",
  caption: "PROJECT",
  iconKind: "markdown",
};

describe("work vault file-preview seam", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.mocked(hqProFetch).mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the shared text preview arm after web presign and fetch", async () => {
    vi.mocked(hqProFetch).mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ url: "https://vault.test/brief.md" }] }),
        { status: 200 },
      ),
    );
    fetchMock.mockResolvedValue(
      new Response("# Approved brief", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      }),
    );

    await expect(
      loadWebVaultFilePreview(previewFile, "cmp_work"),
    ).resolves.toEqual({ kind: "text", text: "# Approved brief" });
    expect(hqProFetch).toHaveBeenCalledWith("/v1/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "cmp_work",
        op: "get",
        key: "projects/demo/brief.md",
      }),
    });
    expect(fetchMock).toHaveBeenCalledWith("https://vault.test/brief.md");
  });

  it("returns the shared unavailable arm when presigning fails", async () => {
    vi.mocked(hqProFetch).mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );

    await expect(
      loadWebVaultFilePreview(previewFile, "cmp_work"),
    ).resolves.toMatchObject({ kind: "unavailable", state: "denied" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseChannelMembers", () => {
  it("maps notify members into status roster rows", () => {
    const members = parseChannelMembers({
      members: [
        {
          personUid: "prs_me",
          displayName: "Stefan Johnson",
          email: "stefan@getindigo.ai",
          role: "owner",
        },
        {
          personUid: "agt_bot",
          displayName: "Mesh Bot",
          role: "member",
        },
      ],
    });
    expect(members).toEqual([
      expect.objectContaining({ personUid: "prs_me", isAgent: false }),
      expect.objectContaining({ personUid: "agt_bot", isAgent: true }),
    ]);
  });
});

describe("metaFromProjectView", () => {
  it("builds board columns and keeps repos on status, not Files", () => {
    const meta = metaFromProjectView(
      {
        companyUid: "cmp_1",
        projectId: "work-mesh-testing",
        name: "work-mesh-testing",
        description: "Live board for HQ Work mesh.",
        stories: [
          { id: "US-001", title: "Directory", status: "done", passes: true },
          { id: "US-002", title: "Board", status: "in_progress" },
        ],
        repos: [{ path: "repos/private/hq-pro", branch: "feature/x" }],
        files: [
          {
            path: "projects/work-mesh-testing/prd.json",
            name: "prd.json",
          },
        ],
      },
      [
        {
          personUid: "prs_me",
          displayName: "Stefan",
          role: "owner",
        },
      ],
      [],
      "Indigo",
    );
    expect(Object.keys(meta.board?.stories ?? {})).toEqual([
      "US-001",
      "US-002",
    ]);
    expect(meta.files.map((file) => file.name)).toEqual(["prd.json"]);
    expect(meta.status?.members[0]?.displayName).toBe("Stefan");
    expect(meta.status?.project.repos[0]?.path).toContain("hq-pro");
    expect(meta.status?.companyLabel).toBe("Indigo");
    expect(meta.status?.project.description).toBe(
      "Live board for HQ Work mesh.",
    );
  });
});
