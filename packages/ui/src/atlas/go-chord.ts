/**
 * Slack-style "g then <key>" navigation chord (US-016: hotkey `g a` → Atlas).
 *
 * Leader `g` arms for GO_CHORD_MS; the next matching letter fires. Ignores
 * chords when focus is in an editable field or when modifiers are held.
 */

export const GO_CHORD_MS = 1000;

export type GoChordHandler = (letter: string) => boolean;

export interface GoChordController {
  /** Feed a keydown. Returns true when the event was consumed. */
  handleKeydown: (event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "target" | "defaultPrevented"
  >) => boolean;
  /** Cancel a pending leader without navigating. */
  reset: () => void;
  /** True while waiting for the second key. */
  isArmed: () => boolean;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest("[contenteditable='true']"));
}

/**
 * Create a go-chord controller. `onChord(letter)` should navigate and return
 * true when the letter is handled (e.g. "a" → Atlas).
 */
export function createGoChord(onChord: GoChordHandler): GoChordController {
  let armedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function reset(): void {
    armedUntil = 0;
    clearTimer();
  }

  function arm(): void {
    armedUntil = Date.now() + GO_CHORD_MS;
    clearTimer();
    timer = setTimeout(() => {
      armedUntil = 0;
      timer = null;
    }, GO_CHORD_MS);
  }

  function isArmed(): boolean {
    return Date.now() < armedUntil;
  }

  function handleKeydown(
    event: Pick<
      KeyboardEvent,
      "key" | "metaKey" | "ctrlKey" | "altKey" | "target" | "defaultPrevented"
    >,
  ): boolean {
    if (event.defaultPrevented) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (isEditableTarget(event.target ?? null)) {
      reset();
      return false;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (isArmed()) {
      reset();
      if (key.length === 1 && onChord(key)) return true;
      return false;
    }

    if (key === "g") {
      arm();
      return true;
    }
    return false;
  }

  return { handleKeydown, reset, isArmed };
}
