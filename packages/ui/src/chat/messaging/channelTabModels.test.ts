import { describe, expect, it } from "vitest";
import {
  BOARD_STAGE_ORDER,
  CHANNEL_FILE_LOADING_PREVIEW,
  CHANNEL_FILE_NO_PREVIEW,
  DEFAULT_VISIBLE_BOARD_STAGES,
  channelFilePreviewBody,
  resolveBoardColumns,
  shouldLoadPreview,
  toggleBoardStage,
  type BoardColumnModel,
  type ChannelFileItemModel,
} from "./channelTabModels";

const injected: BoardColumnModel[] = [
  {
    id: "done",
    title: "Done",
    cards: [{ storyId: "US-001", label: "Send the brief", statusLine: "DONE" }],
  },
];

describe("board column filter", () => {
  it("defaults to To do, Doing, and Done", () => {
    expect(DEFAULT_VISIBLE_BOARD_STAGES).toEqual([
      "queued",
      "in_progress",
      "done",
    ]);
    expect(BOARD_STAGE_ORDER).toEqual([
      "queued",
      "in_progress",
      "review",
      "done",
    ]);
  });

  it("keeps empty stage columns when the host only sent Done", () => {
    const columns = resolveBoardColumns(injected, DEFAULT_VISIBLE_BOARD_STAGES);
    expect(columns.map((c) => [c.id, c.cards.length, c.title])).toEqual([
      ["queued", 0, "To do"],
      ["in_progress", 0, "Doing"],
      ["done", 1, "Done"],
    ]);
  });

  it("can reveal Waiting and hide To do", () => {
    const withReview = toggleBoardStage(DEFAULT_VISIBLE_BOARD_STAGES, "review");
    expect(withReview).toEqual(["queued", "in_progress", "review", "done"]);
    const withoutQueued = toggleBoardStage(withReview, "queued");
    expect(withoutQueued).toEqual(["in_progress", "review", "done"]);
    expect(
      resolveBoardColumns(injected, withoutQueued).map((c) => c.id),
    ).toEqual(["in_progress", "review", "done"]);
  });
});

function fileItem(
  over: Partial<ChannelFileItemModel> = {},
): ChannelFileItemModel {
  return {
    key: "readme",
    vaultPath: "projects/demo/README.md",
    name: "README.md",
    caption: "ADA · AUG 10",
    iconKind: "markdown",
    ...over,
  };
}

describe("shouldLoadPreview", () => {
  it("loads markdown and text when the host provided a loader and there is no authored body", () => {
    expect(shouldLoadPreview(fileItem(), true)).toBe(true);
    expect(shouldLoadPreview(fileItem({ iconKind: "text" }), true)).toBe(true);
  });

  it("does not load authored previewText, denied rows, missing loaders, or non-text kinds", () => {
    expect(
      shouldLoadPreview(fileItem({ previewText: "# already here" }), true),
    ).toBe(false);
    expect(shouldLoadPreview(fileItem({ accessDenied: true }), true)).toBe(
      false,
    );
    expect(shouldLoadPreview(fileItem(), false)).toBe(false);
    expect(shouldLoadPreview(fileItem({ iconKind: "image" }), true)).toBe(
      false,
    );
    expect(shouldLoadPreview(fileItem({ iconKind: "pdf" }), true)).toBe(false);
    expect(shouldLoadPreview(fileItem({ iconKind: "file" }), true)).toBe(false);
  });
});

describe("channelFilePreviewBody", () => {
  it("prefers authored previewText over the loader", () => {
    expect(
      channelFilePreviewBody(fileItem({ previewText: "# already here" }), {
        hasLoader: true,
        cacheHit: false,
      }),
    ).toBe("# already here");
  });

  it("shows loading then the cached body, and falls back when the cache is empty", () => {
    const item = fileItem();
    expect(
      channelFilePreviewBody(item, { hasLoader: true, cacheHit: false }),
    ).toBe(CHANNEL_FILE_LOADING_PREVIEW);
    expect(
      channelFilePreviewBody(item, {
        hasLoader: true,
        cacheHit: true,
        cached: "# from vault",
      }),
    ).toBe("# from vault");
    expect(
      channelFilePreviewBody(item, {
        hasLoader: true,
        cacheHit: true,
        cached: null,
      }),
    ).toBe(CHANNEL_FILE_NO_PREVIEW);
  });

  it("does not load image/pdf/file rows without authored previewText", () => {
    expect(
      channelFilePreviewBody(fileItem({ iconKind: "image" }), {
        hasLoader: true,
        cacheHit: false,
      }),
    ).toBe(CHANNEL_FILE_NO_PREVIEW);
  });
});
