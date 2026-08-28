import { companyStore } from "./company-store.svelte";

export interface CompanyBoardCard {
  id: string;
  title: string;
  subtitle?: string | null;
  href?: string | null;
  labels?: string[];
  assigneeInitials?: string | null;
  tag?: string | null;
  age?: string | null;
  [key: string]: unknown;
}

export interface CompanyBoard {
  inbox: CompanyBoardCard[];
  doing: CompanyBoardCard[];
  review: CompanyBoardCard[];
  done: CompanyBoardCard[];
}

export const emptyCompanyBoard = (): CompanyBoard => ({
  inbox: [],
  doing: [],
  review: [],
  done: [],
});

// Normalize a raw board payload (from invoke or the warm cache) into the four
// always-present columns. Shared by the warm-read paint and the invoke commit
// so both go through identical shaping.
function shapeBoard(raw: CompanyBoard | null | undefined): CompanyBoard {
  return {
    inbox: raw?.inbox ?? [],
    doing: raw?.doing ?? [],
    review: raw?.review ?? [],
    done: raw?.done ?? [],
  };
}

export function useCompanyBoard(options: {
  slug: () => string | null;
  enabled?: () => boolean;
}) {
  let board = $state<CompanyBoard>(emptyCompanyBoard());
  let loading = $state(false);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);
  // One-shot: Retry bumps reloadToken; consume it so a successful force-load's
  // revision bump does not re-enter force mode and loop forever.
  let appliedReloadToken = 0;

  $effect(() => {
    const slug = options.slug();
    const enabled = options.enabled?.() ?? true;
    const token = reloadToken;
    void companyStore.revision;
    const force = token > appliedReloadToken;
    if (force) appliedReloadToken = token;
    error = null;

    if (!slug || !enabled) {
      board = emptyCompanyBoard();
      loading = false;
      return;
    }

    let cancelled = false;

    const warm = companyStore.board(slug);
    if (warm) {
      board = shapeBoard(warm);
      loading = false;
    } else {
      board = emptyCompanyBoard();
      loading = true;
    }

    void companyStore
      .loadBoard(slug, force)
      .then((result) => {
        if (!cancelled) {
          board = shapeBoard(result);
        }
      })
      .catch((err) => {
        console.error("get_company_board failed:", err);
        if (!cancelled) {
          error = String(err);
          if (companyStore.board(slug) === null) board = emptyCompanyBoard();
        }
      })
      .finally(() => {
        if (!cancelled) {
          loading = false;
        }
      });

    return () => {
      cancelled = true;
    };
  });

  return {
    get board() {
      return board;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    retry() {
      reloadToken += 1;
    },
  };
}
