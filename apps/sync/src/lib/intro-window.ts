/**
 * The welcome film's window, from the renderer's side.
 *
 * The film is full screen over the person's real desktop: the Rust command
 * `set_intro_fullscreen` moves `main` onto the whole screen frame (past the
 * menu bar and the Dock), turns on the native full-screen material, and fades
 * the window up from invisible — so the desktop visibly blurs and darkens under
 * the film in one move instead of a window appearing on top of it.
 *
 * The timing model lives here rather than in Rust because it is a design
 * decision about the film, and it has to match the film's own opening beat.
 */

/** Narrow shape of Tauri's `invoke`, so tests can hand in a recorder. */
export type IntroInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Desktop → blurred film. Ease-out over 700ms: long enough that the blur reads
 * as arriving, short enough that nobody waits for the film to start.
 */
export const INTRO_FADE_IN_MS = 700;

/**
 * Blurred film → desktop. Shorter than the entrance: leaving should feel like
 * getting out of the way, and the setup card is waiting behind it.
 */
export const INTRO_FADE_OUT_MS = 450;

export const SET_INTRO_FULLSCREEN = 'set_intro_fullscreen';

/**
 * Take the whole screen and fade the film in.
 *
 * Never throws: the film is decoration in front of setup, so a window command
 * that fails (an OS that has no such window, a test environment with no Tauri)
 * must not stop the film or the wizard behind it.
 */
export async function enterIntroFullscreen(invoke: IntroInvoke): Promise<void> {
  try {
    await invoke(SET_INTRO_FULLSCREEN, { enabled: true, fadeMs: INTRO_FADE_IN_MS });
  } catch (error) {
    console.warn('onboarding: full-screen intro window unavailable', error);
  }
}

/**
 * Fade back to the live desktop and hand the window back exactly as it was.
 *
 * Resolves only once Rust has finished the fade AND the restore, so whatever
 * the caller does next — sizing the setup card, hiding the window after a
 * replay — happens to a window that is already its old size again.
 */
export async function exitIntroFullscreen(invoke: IntroInvoke): Promise<void> {
  try {
    await invoke(SET_INTRO_FULLSCREEN, { enabled: false, fadeMs: INTRO_FADE_OUT_MS });
  } catch (error) {
    console.warn('onboarding: full-screen intro window restore failed', error);
  }
}
