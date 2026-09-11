/**
 * Declared entry point for the Idea Board capture store.
 *
 * The implementation lives in `ideaCaptures.svelte.ts` because it holds Svelte 5
 * rune state (`$state`), which only compiles in a `.svelte.ts` module. This file
 * is the framework-neutral import path the rest of the app (and the PRD) uses.
 */
export {
  createIdeaCapturesStore,
  ideaCaptures,
  type IdeaBoardState,
  type IdeaCapture,
  type IdeaCapturesStore,
  type IdeaKind,
  type IdeaProvenance,
  type IdeaStatus,
} from './ideaCaptures.svelte';
