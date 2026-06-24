// Frontend mirrors of the Rust desktop-alt payloads
// (`src-tauri/src/commands/desktop_alt.rs`). Kept minimal + self-contained for
// the Windows-fork Company OS surface — the upstream macOS build carries a far
// larger model tree (projects-model, kanban, etc.) that this fork has not
// ported. These are the shapes the ported Tauri commands actually return.

/** One board card — a company project / in-flight item. Mirrors `BoardCard`. */
export interface BoardCard {
  id: string;
  title: string;
  subtitle: string | null;
  href: string | null;
  labels: string[];
  assigneeInitials: string | null;
  tag: string | null;
  age: string | null;
}

/** Company board, four columns. Mirrors `CompanyBoard`. */
export interface CompanyBoard {
  inbox: BoardCard[];
  doing: BoardCard[];
  review: BoardCard[];
  done: BoardCard[];
}

export const emptyCompanyBoard = (): CompanyBoard => ({
  inbox: [],
  doing: [],
  review: [],
  done: [],
});

/** Aggregated company summary counts. Mirrors `CompanySummary`. */
export interface CompanySummary {
  board: number;
  activity: {
    last7d: number;
  };
  deployments: number;
  secrets: number;
}

export const emptyCompanySummary = (): CompanySummary => ({
  board: 0,
  activity: { last7d: 0 },
  deployments: 0,
  secrets: 0,
});

/** Ordered board columns for rendering. */
export const BOARD_COLUMNS: { key: keyof CompanyBoard; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'doing', label: 'Doing' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];
