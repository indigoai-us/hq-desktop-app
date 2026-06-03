import { invoke } from '@tauri-apps/api/core';
import { type CompanyBoard, emptyCompanyBoard } from './types';

// Non-reactive warm cache (see company-summary.svelte.ts for the rationale).
const boardBySlug = new Map<string, CompanyBoard>();

/**
 * Reactive company-board loader. Carries the same zero-stuck contract as
 * `useCompanySummary` (port of upstream e3a5e86): react only to a slug-VALUE
 * change, and discard out-of-order completions via a monotonic request id so a
 * rapid company switch (or parent identity churn) can never strand the board on
 * an empty/stale value while the backend returned real data.
 */
export function useCompanyBoard(options: { slug: () => string | null }) {
  let board = $state<CompanyBoard>(emptyCompanyBoard());
  let loading = $state(false);
  let error = $state<string | null>(null);

  let activeSlug: string | null = null;
  let requestId = 0;

  $effect(() => {
    const slug = options.slug();
    if (slug === activeSlug) {
      return;
    }
    activeSlug = slug;
    const myRequest = ++requestId;

    error = null;

    if (!slug) {
      board = emptyCompanyBoard();
      loading = false;
      return;
    }

    const warm = boardBySlug.get(slug) ?? null;
    board = warm ?? emptyCompanyBoard();
    loading = warm === null;

    void invoke<CompanyBoard>('get_company_board', { slug })
      .then((result) => {
        if (myRequest === requestId) {
          board = result;
          boardBySlug.set(slug, result);
        }
      })
      .catch((err) => {
        console.error('get_company_board failed:', err);
        if (myRequest === requestId) {
          error = String(err);
          board = emptyCompanyBoard();
        }
      })
      .finally(() => {
        if (myRequest === requestId) {
          loading = false;
        }
      });
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
  };
}
