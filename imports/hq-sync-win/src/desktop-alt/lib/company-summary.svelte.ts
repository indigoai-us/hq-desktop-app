import { invoke } from '@tauri-apps/api/core';
import { type CompanySummary, emptyCompanySummary } from './types';

// Tiny non-reactive warm cache so a tab/company re-open paints last-known counts
// instantly while the fresh invoke revalidates. Intentionally a plain Map (not
// $state): a write here must never retrigger a mounted effect into a refetch
// loop — it only freshens the value the NEXT mount reads. (Upstream used a
// larger `company-store`; the Windows fork keeps a minimal local cache.)
const summaryBySlug = new Map<string, CompanySummary>();

/**
 * Reactive company-summary loader.
 *
 * ZERO-STUCK FIX (port of upstream e3a5e86): the effect must react ONLY to an
 * actual slug-VALUE change, never to parent identity churn. The desktop shell
 * reassigns the whole workspace list on every focus/refresh, so the parent's
 * `activeCompany` object identity changes constantly even when the selected
 * slug is unchanged. The earlier structure tied a `cancelled` flag to the
 * effect cleanup, so each identity churn cancelled the in-flight
 * `get_company_summary` before its (correct) counts could commit — leaving the
 * UI stuck on zeros while the backend returned real data.
 *
 * Fix: gate on slug-value equality (`slug === activeSlug` → bail) and use a
 * monotonic `requestId` (not an effect-cleanup flag) to discard out-of-order
 * completions when the slug changes rapidly. The loaded summary then sticks
 * across identity churn.
 */
export function useCompanySummary(options: { slug: () => string | null }) {
  let summary = $state<CompanySummary>(emptyCompanySummary());
  let loading = $state(false);
  let error = $state<string | null>(null);

  let activeSlug: string | null = null;
  let requestId = 0;

  $effect(() => {
    const slug = options.slug();
    if (slug === activeSlug) {
      return; // same company — keep the loaded summary, don't refetch/cancel
    }
    activeSlug = slug;
    const myRequest = ++requestId;

    error = null;

    if (!slug) {
      summary = emptyCompanySummary();
      loading = false;
      return;
    }

    // Instant paint from warm cache (if any); otherwise show the loading state.
    const warm = summaryBySlug.get(slug) ?? null;
    summary = warm ?? emptyCompanySummary();
    loading = warm === null;

    void invoke<CompanySummary>('get_company_summary', { slug })
      .then((result) => {
        if (myRequest === requestId) {
          summary = result;
          summaryBySlug.set(slug, result);
        }
      })
      .catch((err) => {
        console.error('get_company_summary failed:', err);
        if (myRequest === requestId) {
          error = String(err);
          summary = emptyCompanySummary();
        }
      })
      .finally(() => {
        if (myRequest === requestId) {
          loading = false;
        }
      });
  });

  return {
    get summary() {
      return summary;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
  };
}
