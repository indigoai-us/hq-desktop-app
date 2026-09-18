/**
 * Timing model for the cinematic first-run intro.
 *
 * Kept as pure data + pure functions so the sequence can be unit-tested
 * without a WebGL context, a canvas, or a Tauri window. The component owns
 * rendering; this module owns *when* each beat is on screen and how far
 * through it we are.
 */

export interface IntroBeat {
  id: string;
  /** Which layout this beat renders as. */
  kind: BeatKind;
  /** Large line. */
  title: string;
  /** Supporting line under the title. */
  body: string;
  /** Milliseconds this beat holds before the next one takes over. */
  holdMs: number;
  /**
   * Palette bias for this beat, 0..1 along the HQ brand spectrum. The gradient
   * field drifts toward this position as the beat becomes active, so the
   * background tells the same story as the copy.
   */
  hue: number;
  /** Present on `kind: 'surfaces'`, `'folder'`, and `'network'` (the capability rail). */
  surfaces?: readonly SurfaceRow[];
  /** Present on `kind: 'shortcuts'` and `kind: 'keyboard'`. */
  shortcuts?: readonly ShortcutRow[];
  /**
   * Present only on `kind: 'keyboard'`: the key ids (see `KEYBOARD_ROWS`) that
   * light up on the drawn keyboard.
   */
  highlightKeys?: readonly string[];
  /** Present only on `kind: 'steps'`. */
  steps?: readonly StepRow[];
  /**
   * Hold here until the person advances instead of timing out. Reference
   * material — a shortcut table, a numbered walkthrough — is read at wildly
   * different speeds, and yanking it away mid-sentence is worse than any
   * timing we could pick. Cinematic statement cards stay on the clock.
   */
  selfPaced?: boolean;
}

/** Cross-fade duration between two beats. */
export const BEAT_FADE_MS = 700;

/** The logo reveal that opens the film, before the first beat. */
export const OVERTURE_MS = 3200;

/**
 * How far into the overture the colour field finishes irising open over the
 * frosted desktop. Before this the person still recognises their own desktop
 * through the glass; after it, HQ owns the screen.
 */
export const TAKEOVER_MS = 2400;

/**
 * How much of the screen the colour field covers at `elapsed`, 0..1, as a
 * radius fraction used by the iris mask. Starts as a small bloom behind the
 * logo and opens past 1 so the field is genuinely edge-to-edge (a mask that
 * stops exactly at 1 leaves a visible circle at the corners).
 */
export function takeoverRadius(elapsed: number): number {
  const t = Math.min(1, Math.max(0, elapsed) / TAKEOVER_MS);
  return 0.12 + easeOutExpo(t) * 1.28;
}

/**
 * Opacity of the colour field over the frosted desktop. Deliberately lags the
 * iris: the field grows first at low opacity (desktop still readable through
 * it), then solidifies.
 */
export function takeoverOpacity(elapsed: number): number {
  const t = Math.min(1, Math.max(0, elapsed) / TAKEOVER_MS);
  return easeInOut(Math.min(1, t * 1.35));
}

/** Fast-out curve for the iris — most of the travel happens up front. */
export function easeOutExpo(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped >= 1 ? 1 : 1 - Math.pow(2, -9 * clamped);
}

/**
 * The HQ brand spectrum, sampled from the approved app icon
 * (`src-tauri/icons/app-icon.svg`). The gradient field interpolates within
 * this list — it never invents a hue outside it.
 */
export const HQ_SPECTRUM: readonly string[] = [
  '#7de3f4',
  '#8b6df0',
  '#e56ab3',
  '#f28a4b',
  '#f5f5f5',
];

/**
 * The palette the gradient field itself samples. Deliberately drops the
 * spectrum's near-white terminal stop — at full-screen scale a white body
 * washes the whole field to grey and takes the brand colour with it. White
 * stays in `HQ_SPECTRUM` for marks and chrome that legitimately need it.
 */
export const FIELD_SPECTRUM: readonly string[] = [
  '#7de3f4',
  '#8b6df0',
  '#e56ab3',
  '#f28a4b',
];

/**
 * A row in a `surfaces` scene — one named part of HQ and what it is.
 * Mirrors the folder tour's grammar: the name in mono, the meaning in prose.
 */
export interface SurfaceRow {
  name: string;
  meaning: string;
}

/** A row in a `shortcuts` scene. `keys` are rendered as individual keycaps. */
export interface ShortcutRow {
  keys: string[];
  does: string;
}

/** A row in a `steps` scene — the numbered walkthrough. */
export interface StepRow {
  title: string;
  detail: string;
}

/**
 * The visual grammar a beat uses. `statement` is the plain cinematic title
 * card; the others carry structured content that the intro renders as its own
 * layout. A beat's `holdMs` should scale with how much there is to read.
 */
export type BeatKind = 'statement' | 'surfaces' | 'folder' | 'network' | 'shortcuts' | 'keyboard' | 'steps';

export const INTRO_BEATS: readonly IntroBeat[] = [
  {
    id: 'folder',
    kind: 'folder',
    title: "It's a folder",
    body: 'HQ lives on your machine as plain files. Your work, your rules, your team\u2019s memory \u2014 and any AI sits on top of it.',
    // The folder holds alone for ~2s, travels left, then the tree writes in
    // by ~3.5s. Four more seconds is enough to read five short rows.
    holdMs: 8000,
    hue: 0.1,
    surfaces: [
      { name: 'companies/', meaning: 'A wall per client. One company\u2019s context can never reach another\u2019s.' },
      { name: 'personal/', meaning: 'You. Your preferences and the rules you teach HQ, in every company.' },
      { name: 'repos/', meaning: 'Your actual code. Nothing wrapped, nothing hidden.' },
      { name: 'workspace/', meaning: 'Sessions, drafts, and handoffs \u2014 the memory between chats.' },
      { name: 'core/', meaning: 'HQ\u2019s own machinery. An update replaces this and never your work.' },
    ],
  },
  {
    id: 'cloud',
    kind: 'network',
    title: 'Your folder is local. Your team is not.',
    body: 'Every machine syncs to the same company cloud. People and agents share one context.',
    holdMs: 11_000,
    hue: 0.42,
    surfaces: [
      { name: 'sync', meaning: 'Same on every machine' },
      { name: 'secrets', meaning: 'Injected at run time' },
      { name: 'permissions', meaning: 'Who sees which folder' },
      { name: 'deploys', meaning: 'Anything becomes a link' },
      { name: 'messages', meaning: 'People and agents, one thread' },
    ],
  },
  {
    id: 'shortcuts',
    kind: 'keyboard',
    title: 'One shortcut to remember',
    body: 'From anywhere on your Mac, this opens the HQ desktop view.',
    holdMs: 9000,
    hue: 0.6,
    selfPaced: true,
    shortcuts: [
      { keys: ['\u2325', '\u21E7', 'O'], does: 'Open the HQ desktop view' },
    ],
    highlightKeys: ['alt', 'shift', 'o'],
  },
  {
    id: 'first-agent',
    kind: 'steps',
    title: 'Your first agent',
    body: 'Once setup finishes, this is the shortest path to something real.',
    holdMs: 11_000,
    hue: 0.82,
    selfPaced: true,
    steps: [
      {
        title: 'Finish setting up',
        detail: 'Pick where HQ lives, then run /setup in Claude Code. It wires up the rest.',
      },
      {
        title: 'Start a session with /startwork',
        detail: 'It works out which company you are in and loads the right context. Skipping it is the main reason a session feels like it forgot everything.',
      },
      {
        title: 'Hire your first worker with /new-agent',
        detail: 'A worker is a bounded agent — its own identity, its own context, its own permissions. It only ever acts inside the company you gave it.',
      },
      {
        title: 'End with /handoff',
        detail: 'The one habit that makes HQ compound. The next session picks up exactly where this one stopped.',
      },
    ],
  },
] as const satisfies readonly IntroBeat[];

/**
 * Elapsed time at which `beats[index]` starts. Used to jump the clock forward
 * when somebody advances past a self-paced beat.
 */
export function beatStartMs(
  index: number,
  beats: readonly IntroBeat[] = INTRO_BEATS,
): number {
  let total = OVERTURE_MS;
  for (let i = 0; i < Math.min(index, beats.length); i += 1) {
    total += beats[i].holdMs;
  }
  return total;
}

/**
 * Whether the film should stop advancing at `elapsed`. True once a self-paced
 * beat has finished fading in — it then waits for the person. The fade-in must
 * complete first, or the beat would freeze while still half transparent.
 */
export function isWaitingForViewer(
  elapsed: number,
  beats: readonly IntroBeat[] = INTRO_BEATS,
): boolean {
  const { index, progress, complete } = beatAt(elapsed, beats);
  if (complete || index < 0) return false;
  const beat = beats[index];
  if (!beat?.selfPaced) return false;
  return progress * beat.holdMs >= BEAT_FADE_MS;
}

/** Total runtime of the film when nobody skips ahead. */
export function introDurationMs(beats: readonly IntroBeat[] = INTRO_BEATS): number {
  return OVERTURE_MS + beats.reduce((total, beat) => total + beat.holdMs, 0);
}

export interface BeatPosition {
  /** `-1` while the overture is still playing. */
  index: number;
  /** 0..1 through the current beat (0 through the overture). */
  progress: number;
  /** True once the last beat has finished holding. */
  complete: boolean;
}

/**
 * Where the film is at `elapsed` milliseconds. Clamps at both ends so a
 * backgrounded window that resumes late lands on the final beat rather than
 * running off the end of the array.
 */
export function beatAt(
  elapsed: number,
  beats: readonly IntroBeat[] = INTRO_BEATS,
): BeatPosition {
  if (beats.length === 0) {
    return { index: -1, progress: 0, complete: elapsed >= OVERTURE_MS };
  }
  if (elapsed < OVERTURE_MS) {
    return {
      index: -1,
      progress: Math.min(1, Math.max(0, elapsed) / OVERTURE_MS),
      complete: false,
    };
  }

  let cursor = elapsed - OVERTURE_MS;
  for (let index = 0; index < beats.length; index += 1) {
    const hold = beats[index].holdMs;
    if (cursor < hold) {
      return { index, progress: hold === 0 ? 1 : cursor / hold, complete: false };
    }
    cursor -= hold;
  }
  return { index: beats.length - 1, progress: 1, complete: true };
}

/**
 * Palette position (0..1) for a moment in the film. Eases between the
 * neighbouring beats' `hue` values so the background never snaps.
 */
export function hueAt(
  elapsed: number,
  beats: readonly IntroBeat[] = INTRO_BEATS,
): number {
  if (beats.length === 0) return 0;
  const { index, progress } = beatAt(elapsed, beats);
  if (index < 0) return beats[0].hue;
  const current = beats[index].hue;
  const next = beats[index + 1]?.hue ?? current;
  return current + (next - current) * easeInOut(progress);
}

/** Symmetric ease so hue drift accelerates out of a beat and settles into the next. */
export function easeInOut(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5
    ? 2 * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 2) / 2;
}

/**
 * Opacity for a beat's copy at `elapsed`: fades in over `BEAT_FADE_MS`, holds,
 * then fades out over the same window. Off-beats are fully transparent, so the
 * component can render every beat at once and let this drive the cross-fade.
 */
export function beatOpacity(
  index: number,
  elapsed: number,
  beats: readonly IntroBeat[] = INTRO_BEATS,
): number {
  const position = beatAt(elapsed, beats);
  if (position.index !== index) return 0;
  const hold = beats[index]?.holdMs ?? 0;
  const into = position.progress * hold;
  const out = hold - into;
  const fadeIn = Math.min(1, into / BEAT_FADE_MS);
  const fadeOut = Math.min(1, out / BEAT_FADE_MS);
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

/**
 * Reduced motion does not mean "no intro" — it means no drifting field and no
 * per-beat animation. The copy still advances, just cut rather than dissolved,
 * and at a faster clip since nothing has to breathe.
 */
export function reducedMotionBeats(
  beats: readonly IntroBeat[] = INTRO_BEATS,
): IntroBeat[] {
  return beats.map((beat) => ({ ...beat, holdMs: Math.round(beat.holdMs * 0.55) }));
}

/** Parse `#rrggbb` into normalized floats for the shader's uniform array. */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`intro-sequence: not a hex color: ${hex}`);
  }
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

/** Sample the spectrum at `t` (0..1) with linear interpolation between stops. */
export function sampleSpectrum(
  t: number,
  spectrum: readonly string[] = HQ_SPECTRUM,
): [number, number, number] {
  if (spectrum.length === 0) throw new Error('intro-sequence: empty spectrum');
  if (spectrum.length === 1) return hexToRgb(spectrum[0]);
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (spectrum.length - 1);
  const lower = Math.min(spectrum.length - 2, Math.floor(scaled));
  const mix = scaled - lower;
  const a = hexToRgb(spectrum[lower]);
  const b = hexToRgb(spectrum[lower + 1]);
  return [
    a[0] + (b[0] - a[0]) * mix,
    a[1] + (b[1] - a[1]) * mix,
    a[2] + (b[2] - a[2]) * mix,
  ];
}

/** One keycap on the drawn keyboard. `w` is width in key units (1 = a letter key). */
export interface KeyCap {
  id: string;
  label: string;
  w?: number;
  /** Secondary glyph rendered above the label (⌥ over "option"). */
  glyph?: string;
}

/**
 * A compact ANSI Mac layout, enough to draw a recognisable keyboard and light
 * a chord on it. Widths follow the physical board so the rows line up.
 */
export const KEYBOARD_ROWS: readonly (readonly KeyCap[])[] = [
  [
    { id: 'esc', label: 'esc', w: 1.5 },
    ...['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'].map((f) => ({ id: f.toLowerCase(), label: f, w: 1 })),
  ],
  [
    { id: 'grave', label: '`' },
    ...'1234567890'.split('').map((k) => ({ id: k, label: k })),
    { id: 'minus', label: '-' },
    { id: 'equal', label: '=' },
    { id: 'backspace', label: 'delete', w: 1.5 },
  ],
  [
    { id: 'tab', label: 'tab', w: 1.5 },
    ...'QWERTYUIOP'.split('').map((k) => ({ id: k.toLowerCase(), label: k })),
    { id: 'lbracket', label: '[' },
    { id: 'rbracket', label: ']' },
    { id: 'backslash', label: '\\' },
  ],
  [
    { id: 'caps', label: 'caps lock', w: 1.85 },
    ...'ASDFGHJKL'.split('').map((k) => ({ id: k.toLowerCase(), label: k })),
    { id: 'semicolon', label: ';' },
    { id: 'quote', label: "'" },
    { id: 'return', label: 'return', w: 1.65 },
  ],
  [
    { id: 'shift', label: 'shift', w: 2.35, glyph: '\u21E7' },
    ...'ZXCVBNM'.split('').map((k) => ({ id: k.toLowerCase(), label: k })),
    { id: 'comma', label: ',' },
    { id: 'period', label: '.' },
    { id: 'slash', label: '/' },
    { id: 'rshift', label: 'shift', w: 2.15, glyph: '\u21E7' },
  ],
  [
    { id: 'fn', label: 'fn' },
    { id: 'ctrl', label: 'control', glyph: '\u2303' },
    { id: 'alt', label: 'option', glyph: '\u2325' },
    { id: 'cmd', label: 'command', w: 1.25, glyph: '\u2318' },
    { id: 'space', label: '', w: 5.5 },
    { id: 'rcmd', label: 'command', w: 1.25, glyph: '\u2318' },
    { id: 'ralt', label: 'option', glyph: '\u2325' },
    { id: 'left', label: '\u25C2' },
    { id: 'updown', label: '\u25B4\u25BE' },
    { id: 'right', label: '\u25B8' },
  ],
];

/** Every key id on the board, for validating a beat's `highlightKeys`. */
export const KEYBOARD_KEY_IDS: ReadonlySet<string> = new Set(
  KEYBOARD_ROWS.flatMap((row) => row.map((key) => key.id)),
);
