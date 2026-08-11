<script lang="ts">
  /**
   * CompanySkillsPage — first-class company Skills page (hq-desktop-v2 US-009),
   * promoted from the deep-link-only CompanyLibraryPanel skills tab. Scoped to
   * the ACTIVE workspace slug: header ("Company-scoped workflows and operating
   * knowledge"), live count, text search, and the shared Library card grid —
   * each card carries name, tools-count chip, scope chip, and one-line
   * description; the detail slide-over reuses LibraryDetailPanel.
   *
   * Load convention mirrors the other company pages: slug-keyed $effect with a
   * cancel flag so switching companies fast can't paint stale data. A second
   * $effect subscribes to window focus / sync:complete and bumps `refreshNonce`,
   * so a skill created in another tool surfaces without remounting the page.
   */
  import { loadLibraryCompany, type LibraryItems } from '../lib/library';
  import { subscribeLibraryRefresh } from '../lib/library-refresh';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import LibraryBrowser from '../components/LibraryBrowser.svelte';

  interface Props {
    /** The active company/workspace slug this page is scoped to. */
    slug: string;
  }

  let { slug }: Props = $props();

  let items = $state<LibraryItems>({ workers: [], skills: [] });
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** Bumped by the focus / sync:complete refresh subscription to re-fetch. */
  let refreshNonce = $state(0);
  const visibleCount = $derived(items.skills.length);

  $effect(() => {
    const activeSlug = slug;
    // Re-run whenever the refresh subscription bumps the nonce.
    refreshNonce;
    items = { workers: [], skills: [] };
    error = null;

    if (!activeSlug) {
      loading = false;
      return;
    }

    loading = true;
    let cancelled = false;

    void (async () => {
      try {
        const result = await loadLibraryCompany(activeSlug);
        if (!cancelled) items = result;
      } catch (err) {
        console.error('loadLibraryCompany failed:', err);
        if (!cancelled) {
          error = 'Skills unavailable. Try again after a sync.';
          items = { workers: [], skills: [] };
        }
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  // Re-fetch on window focus / sync:complete so a skill created elsewhere
  // appears without remounting the page. Wired once.
  $effect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    void subscribeLibraryRefresh(() => {
      refreshNonce += 1;
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  });
</script>

<section class="company-library" aria-label="Skills" data-testid="company-skills-panel">
  <header class="company-library-header">
    <div>
      <h2>Skills</h2>
      <p>Company-scoped workflows and operating knowledge</p>
    </div>
    <span>{loading ? 'Loading' : `${visibleCount} ${visibleCount === 1 ? 'skill' : 'skills'}`}</span>
  </header>

  {#if !loading && !error && items.skills.length === 0}
    <div class="empty-state">
      No company-specific skills yet. Shared skills live in the top-level Library.
    </div>
  {:else}
    <LibraryBrowser {items} {loading} {error} forcedFilter="skills" />
  {/if}
</section>

<style>
  .company-library {
    display: grid;
    gap: var(--v4-space-4);
    min-width: 0;
  }

  .company-library-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--v4-space-4);
    padding-bottom: var(--v4-space-3);
    border-bottom: 1px solid var(--v4-hairline);
  }

  .company-library-header div {
    min-width: 0;
  }

  .company-library-header h2,
  .company-library-header p {
    margin: 0;
  }

  .company-library-header h2 {
    color: var(--v4-text-1);
    font-size: var(--type-section);
    font-weight: 600;
  }

  .company-library-header p,
  .company-library-header > span {
    color: var(--v4-text-3);
    font-size: var(--type-secondary);
  }

  .company-library-header p {
    margin-top: var(--v4-row-stack-gap);
  }

  .company-library-header > span {
    white-space: nowrap;
  }

  .empty-state {
    padding: var(--v4-space-4);
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    color: var(--v4-text-3);
    font-size: var(--text-base);
    text-align: center;
  }
</style>
