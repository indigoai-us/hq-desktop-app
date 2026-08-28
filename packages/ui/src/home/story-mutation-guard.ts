export interface StoryMutationTarget {
  storyId: string;
  prdPath: string;
  generation: number;
}

/**
 * Guards async task mutations against selection changes.
 *
 * A result is current only for the exact story + PRD path that launched it.
 * Invalidating on prop changes also means a second mutation for the same story
 * supersedes the first instead of letting completions race.
 */
export function createStoryMutationGuard() {
  let generation = 0;

  return {
    invalidate(): void {
      generation += 1;
    },

    capture(storyId: string, prdPath: string): StoryMutationTarget {
      generation += 1;
      return { storyId, prdPath, generation };
    },

    isCurrent(
      target: StoryMutationTarget,
      currentStoryId: string | null | undefined,
      currentPrdPath: string,
    ): boolean {
      return (
        target.generation === generation &&
        target.storyId === currentStoryId &&
        target.prdPath === currentPrdPath
      );
    },
  };
}
