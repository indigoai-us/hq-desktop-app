import { describe, expect, it } from 'vitest';
import {
  BEAT_FADE_MS,
  TAKEOVER_MS,
  beatStartMs,
  easeOutExpo,
  isWaitingForViewer,
  takeoverOpacity,
  takeoverRadius,
  FIELD_SPECTRUM,
  HQ_SPECTRUM,
  INTRO_BEATS,
  OVERTURE_MS,
  beatAt,
  beatOpacity,
  easeInOut,
  hexToRgb,
  hueAt,
  introDurationMs,
  reducedMotionBeats,
  sampleSpectrum,
} from './intro-sequence';

const BEATS = INTRO_BEATS;

describe('beatAt', () => {
  it('reports the overture before the first beat', () => {
    expect(beatAt(0).index).toBe(-1);
    expect(beatAt(OVERTURE_MS - 1).index).toBe(-1);
  });

  it('enters the first beat exactly at the end of the overture', () => {
    const position = beatAt(OVERTURE_MS);
    expect(position.index).toBe(0);
    expect(position.progress).toBe(0);
    expect(position.complete).toBe(false);
  });

  it('advances through every beat in order', () => {
    let elapsed = OVERTURE_MS;
    BEATS.forEach((beat, index) => {
      expect(beatAt(elapsed + beat.holdMs / 2).index).toBe(index);
      elapsed += beat.holdMs;
    });
  });

  it('clamps to the last beat and reports completion past the end', () => {
    const past = beatAt(introDurationMs() + 60_000);
    expect(past.index).toBe(BEATS.length - 1);
    expect(past.progress).toBe(1);
    expect(past.complete).toBe(true);
  });

  it('completes exactly at the total duration', () => {
    expect(beatAt(introDurationMs()).complete).toBe(true);
  });

  it('treats negative elapsed as the start of the overture', () => {
    expect(beatAt(-500).index).toBe(-1);
    expect(beatAt(-500).progress).toBe(0);
  });
});

describe('beatOpacity', () => {
  it('is zero for beats that are not the active one', () => {
    const midFirst = OVERTURE_MS + BEATS[0].holdMs / 2;
    expect(beatOpacity(1, midFirst)).toBe(0);
    expect(beatOpacity(2, midFirst)).toBe(0);
  });

  it('fades in from zero and reaches full opacity mid-beat', () => {
    expect(beatOpacity(0, OVERTURE_MS)).toBe(0);
    expect(beatOpacity(0, OVERTURE_MS + BEAT_FADE_MS / 2)).toBeCloseTo(0.5, 5);
    expect(beatOpacity(0, OVERTURE_MS + BEATS[0].holdMs / 2)).toBe(1);
  });

  it('fades back out at the end of the beat', () => {
    const nearEnd = OVERTURE_MS + BEATS[0].holdMs - BEAT_FADE_MS / 2;
    expect(beatOpacity(0, nearEnd)).toBeCloseTo(0.5, 5);
  });

  it('never returns a value outside 0..1', () => {
    for (let t = 0; t < introDurationMs() + 2000; t += 137) {
      BEATS.forEach((_, index) => {
        const value = beatOpacity(index, t);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      });
    }
  });
});

describe('hueAt', () => {
  it('holds the first beat colour through the overture', () => {
    expect(hueAt(0)).toBe(BEATS[0].hue);
    expect(hueAt(OVERTURE_MS - 1)).toBe(BEATS[0].hue);
  });

  it('drifts monotonically from one beat colour toward the next', () => {
    const start = hueAt(OVERTURE_MS);
    const mid = hueAt(OVERTURE_MS + BEATS[0].holdMs / 2);
    const end = hueAt(OVERTURE_MS + BEATS[0].holdMs - 1);
    expect(start).toBeCloseTo(BEATS[0].hue, 5);
    expect(mid).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(mid);
    expect(end).toBeLessThanOrEqual(BEATS[1].hue);
  });

  it('settles on the last beat colour rather than running off the end', () => {
    expect(hueAt(introDurationMs() + 10_000)).toBeCloseTo(
      BEATS[BEATS.length - 1].hue,
      5,
    );
  });
});

describe('easeInOut', () => {
  it('pins both ends and clamps out-of-range input', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(-3)).toBe(0);
    expect(easeInOut(4)).toBe(1);
  });

  it('is symmetric about the midpoint', () => {
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 6);
  });
});

describe('reducedMotionBeats', () => {
  it('keeps every beat but shortens the film', () => {
    const reduced = reducedMotionBeats();
    expect(reduced).toHaveLength(BEATS.length);
    expect(reduced.map((b) => b.id)).toEqual(BEATS.map((b) => b.id));
    expect(introDurationMs(reduced)).toBeLessThan(introDurationMs());
  });

  it('does not mutate the source beats', () => {
    const before = BEATS.map((b) => b.holdMs);
    reducedMotionBeats();
    expect(BEATS.map((b) => b.holdMs)).toEqual(before);
  });
});

describe('hexToRgb', () => {
  it('parses six-digit and three-digit hex', () => {
    expect(hexToRgb('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#fff')).toEqual([1, 1, 1]);
  });

  it('throws on input that is not a hex colour', () => {
    expect(() => hexToRgb('rebeccapurple')).toThrow(/not a hex color/);
    expect(() => hexToRgb('#12345')).toThrow(/not a hex color/);
  });
});

describe('sampleSpectrum', () => {
  it('returns the endpoints exactly', () => {
    // Float interpolation at the exact endpoints can land one ULP off, so
    // compare per channel rather than by strict structural equality.
    sampleSpectrum(0).forEach((channel, i) => {
      expect(channel).toBeCloseTo(hexToRgb(HQ_SPECTRUM[0])[i], 10);
    });
    const last = hexToRgb(HQ_SPECTRUM[HQ_SPECTRUM.length - 1]);
    sampleSpectrum(1).forEach((channel, i) => {
      expect(channel).toBeCloseTo(last[i], 10);
    });
  });

  it('clamps out-of-range positions to the endpoints', () => {
    expect(sampleSpectrum(-2)).toEqual(sampleSpectrum(0));
    expect(sampleSpectrum(9)).toEqual(sampleSpectrum(1.0));
  });

  it('stays inside 0..1 per channel across the whole spectrum', () => {
    for (let t = 0; t <= 1.0001; t += 0.01) {
      sampleSpectrum(t).forEach((channel) => {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      });
    }
  });

  it('interpolates between neighbouring stops', () => {
    const [r] = sampleSpectrum(0.125, ['#000000', '#ffffff']);
    expect(r).toBeCloseTo(0.125, 5);
  });

  it('leaves the washed-out terminal stop out of the field palette', () => {
    // The near-white stop greys the whole field at full-screen scale — it is
    // deliberately absent from the palette the shader samples.
    expect(HQ_SPECTRUM).toContain('#f5f5f5');
    expect(FIELD_SPECTRUM).not.toContain('#f5f5f5');
  });
});

describe('beatStartMs', () => {
  it('places the first beat at the end of the overture', () => {
    expect(beatStartMs(0)).toBe(OVERTURE_MS);
  });

  it('accumulates every preceding hold', () => {
    expect(beatStartMs(1)).toBe(OVERTURE_MS + BEATS[0].holdMs);
    expect(beatStartMs(BEATS.length)).toBe(introDurationMs());
  });

  it('is the exact elapsed at which that beat becomes active', () => {
    BEATS.forEach((_, index) => {
      expect(beatAt(beatStartMs(index)).index).toBe(index);
    });
  });

  it('clamps past the end rather than reading off the array', () => {
    expect(beatStartMs(99)).toBe(introDurationMs());
  });
});

describe('isWaitingForViewer', () => {
  const selfPacedIndex = BEATS.findIndex((beat) => beat.selfPaced);

  it('has at least one self-paced beat to hold on', () => {
    expect(selfPacedIndex).toBeGreaterThanOrEqual(0);
  });

  it('never waits during the overture', () => {
    expect(isWaitingForViewer(0)).toBe(false);
    expect(isWaitingForViewer(OVERTURE_MS - 1)).toBe(false);
  });

  it('does not wait on a timed beat', () => {
    const timedIndex = BEATS.findIndex((beat) => !beat.selfPaced);
    const mid = beatStartMs(timedIndex) + BEATS[timedIndex].holdMs / 2;
    expect(isWaitingForViewer(mid)).toBe(false);
  });

  it('waits only after the self-paced beat has finished fading in', () => {
    const start = beatStartMs(selfPacedIndex);
    expect(isWaitingForViewer(start)).toBe(false);
    expect(isWaitingForViewer(start + BEAT_FADE_MS - 1)).toBe(false);
    expect(isWaitingForViewer(start + BEAT_FADE_MS)).toBe(true);
  });

  it('stops waiting once the film is complete', () => {
    expect(isWaitingForViewer(introDurationMs() + 5_000)).toBe(false);
  });
});

describe('takeover', () => {
  it('opens the iris from a small bloom to past the corners', () => {
    expect(takeoverRadius(0)).toBeCloseTo(0.12, 3);
    expect(takeoverRadius(TAKEOVER_MS)).toBeGreaterThan(1.2);
  });

  it('never shrinks as time passes', () => {
    let previous = -1;
    for (let t = 0; t <= TAKEOVER_MS + 2000; t += 50) {
      const radius = takeoverRadius(t);
      expect(radius).toBeGreaterThanOrEqual(previous);
      previous = radius;
    }
  });

  it('ramps the field from transparent to fully opaque', () => {
    expect(takeoverOpacity(0)).toBe(0);
    expect(takeoverOpacity(TAKEOVER_MS)).toBe(1);
    expect(takeoverOpacity(TAKEOVER_MS * 10)).toBe(1);
  });

  it('finishes solidifying before the overture ends, so no beat starts mid-fade', () => {
    expect(takeoverOpacity(OVERTURE_MS)).toBe(1);
  });

  it('clamps negative elapsed', () => {
    expect(takeoverOpacity(-100)).toBe(0);
    expect(takeoverRadius(-100)).toBeCloseTo(0.12, 3);
  });
});

describe('easeOutExpo', () => {
  it('pins both ends and clamps out-of-range input', () => {
    expect(easeOutExpo(0)).toBe(0);
    expect(easeOutExpo(1)).toBe(1);
    expect(easeOutExpo(-1)).toBe(0);
    expect(easeOutExpo(2)).toBe(1);
  });

  it('front-loads the travel', () => {
    expect(easeOutExpo(0.25)).toBeGreaterThan(0.5);
  });
});

describe('beat content', () => {
  it('gives every beat a unique id', () => {
    expect(new Set(BEATS.map((b) => b.id)).size).toBe(BEATS.length);
  });

  it('carries the payload its kind claims, and no other', () => {
    BEATS.forEach((beat) => {
      expect(beat.surfaces !== undefined).toBe(beat.kind === 'surfaces');
      expect(beat.shortcuts !== undefined).toBe(beat.kind === 'shortcuts');
      expect(beat.steps !== undefined).toBe(beat.kind === 'steps');
    });
  });

  it('holds the reference scenes for the person to advance', () => {
    BEATS.forEach((beat) => {
      if (beat.kind === 'shortcuts' || beat.kind === 'steps') {
        expect(beat.selfPaced).toBe(true);
      }
    });
  });

  it('gives every shortcut at least one keycap and a description', () => {
    const shortcuts = BEATS.flatMap((b) => b.shortcuts ?? []);
    expect(shortcuts.length).toBeGreaterThan(0);
    shortcuts.forEach((row) => {
      expect(row.keys.length).toBeGreaterThan(0);
      expect(row.does.trim()).not.toBe('');
    });
  });

  it('moves the hue forward through the film so the field never doubles back', () => {
    const hues = BEATS.map((b) => b.hue);
    expect([...hues].sort((a, b) => a - b)).toEqual(hues);
    hues.forEach((hue) => {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(1);
    });
  });
});
