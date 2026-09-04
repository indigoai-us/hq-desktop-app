/**
 * Agent background tasks — model, classification, and generated mark art.
 *
 * A task chip shows three things: a generated mark, the task's title, and a
 * status word. This module owns the first and the classification behind it.
 *
 * The mark catalogue is FIXED and enumerable — 8 families x 100 variants = 800
 * marks. A mark is addressed by (family, index) and its art is regenerated from
 * that address, so the catalogue is stable forever without shipping 800 image
 * assets. Assignment is deliberately two-part:
 *
 *   family <- the task's CATEGORY, so the shape carries meaning (a deploy always
 *             looks planetary, a fix always looks like a star)
 *   index  <- hash(task id), so the mark carries identity (a task always gets
 *             the same one, and two tasks in a category still look distinct)
 *
 * Art is built from individually shaded sub-shapes lit from one shared light
 * source — that is what gives a mark volume rather than a flat silhouette.
 *
 * Kept rune-free and dependency-free so it is trivially unit-testable, matching
 * pack-covers.ts. Colours are emitted as hsla() only; no hardcoded hex.
 */

// ── Task model ───────────────────────────────────────────────────────────────

export type AgentTaskStatus = 'queued' | 'working' | 'waiting' | 'done' | 'failed';

export interface AgentTask {
  /** Stable id — decides which mark variant the task keeps for life. */
  id: string;
  title: string;
  status: AgentTaskStatus;
  /** Optional explicit category; otherwise derived from the title. */
  category?: TaskCategory;
}

/**
 * Status wording stays calm and factual — no urgency language, no invented
 * progress. Only states the task registry actually reports are represented.
 */
export const AGENT_TASK_STATUS_LABEL: Record<AgentTaskStatus, string> = {
  queued: 'Queued',
  working: 'Working in the background',
  waiting: 'Waiting on you',
  done: 'Done',
  failed: 'Failed',
};

/** Maps to the v4 status tokens, same shape as agency.ts statusTone(). */
export type AgentTaskTone = 'ok' | 'warn' | 'idle' | 'unread' | 'error';

export function agentTaskTone(status: AgentTaskStatus): AgentTaskTone {
  switch (status) {
    case 'done':
      return 'ok';
    case 'waiting':
      return 'warn';
    case 'failed':
      return 'error';
    case 'working':
      return 'unread';
    default:
      return 'idle';
  }
}

// ── Classification ───────────────────────────────────────────────────────────

export type TaskCategory =
  | 'build' | 'fix' | 'review' | 'data'
  | 'research' | 'design' | 'deploy' | 'infra';

export type TaskFamily =
  | 'bloom' | 'star' | 'vesica' | 'flowerlife'
  | 'seed' | 'mandala' | 'planet' | 'orbit';

export const TASK_FAMILIES: TaskFamily[] = [
  'bloom', 'star', 'vesica', 'flowerlife', 'seed', 'mandala', 'planet', 'orbit',
];

export const TASK_POOL_PER_FAMILY = 100;

/** What each family means. Family is chosen by category, never at random. */
export const CATEGORY_FAMILY: Record<TaskCategory, TaskFamily> = {
  build: 'bloom',       // making something new — growth
  fix: 'star',          // a correction; a point of light
  review: 'vesica',     // the lens — examination
  data: 'flowerlife',   // interlocking records
  research: 'seed',     // the seed of an idea
  design: 'mandala',    // composition
  deploy: 'planet',     // shipping to a world
  infra: 'orbit',       // systems in motion
};

export const CATEGORY_LABEL: Record<TaskCategory, string> = {
  build: 'Build', fix: 'Fix', review: 'Review', data: 'Data',
  research: 'Research', design: 'Design', deploy: 'Deploy', infra: 'Infra',
};

/**
 * Keyword routing, first match wins. Stems use \w* rather than a trailing \b —
 * a word boundary after a partial stem can never match, which would silently
 * send "investigate" to the fallback instead of Research.
 */
const CATEGORY_RULES: ReadonlyArray<readonly [TaskCategory, RegExp]> = [
  ['deploy', /\b(deploy\w*|release\w*|ship|shipping|publish\w*|rollout|launch\w*)\b/i],
  ['infra', /\b(infra\w*|runner\w*|cluster\w*|provision\w*|worker\w*|queue\w*|cron|host\w*|scaling)\b/i],
  ['data', /\b(backfill\w*|migrat\w*|reindex\w*|index\w*|sync\w*|import\w*|export\w*|etl|dataset\w*|record\w*)\b/i],
  ['fix', /\b(fix\w*|repair\w*|bug\w*|patch\w*|hotfix|regress\w*|restore\w*|recover\w*)\b/i],
  ['review', /\b(review\w*|audit\w*|verif\w*|inspect\w*|lint\w*|scan\w*)\b/i],
  ['research', /\b(research\w*|investigat\w*|explor\w*|analy\w*|stud(y|ies)|spike|diagnos\w*|debug\w*)\b/i],
  ['design', /\b(design\w*|layout\w*|theme\w*|brand\w*|icon\w*|styl\w*|polish\w*|copy)\b/i],
  ['build', /\b(build\w*|implement\w*|add|adds|adding|creat\w*|feature\w*|scaffold\w*|wire\w*|refactor\w*)\b/i],
];

/** Classify a task title. Returns null when nothing matches. */
export function classifyTask(title: string | null | undefined): TaskCategory | null {
  const text = String(title ?? '');
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return null;
}

// ── Deterministic seeding ────────────────────────────────────────────────────

/** FNV-1a, matching the hash already used by pack-covers.ts. */
export function hashTaskId(value: string): number {
  let hash = 2166136261 >>> 0;
  const text = value.length > 0 ? value : 'task';
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32 — small, well-distributed seeded PRNG. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The canonical address of a catalogue entry. */
export function taskMarkAddress(family: TaskFamily, index: number): string {
  return `pool-${family}-${String(index).padStart(3, '0')}`;
}

// ── Mark art ─────────────────────────────────────────────────────────────────

/** One light for the whole mark, upper left. */
const LIGHT = { x: 34, y: 26 };

const hsl = (h: number, s: number, l: number, a = 1): string =>
  `hsla(${(((h % 360) + 360) % 360) | 0} ${s.toFixed(0)}% ${l.toFixed(0)}% / ${a})`;

interface Shade { hi?: number; mid?: number; lo?: number; a?: number }

/** Sphere shading for a round sub-shape: focal point pulled toward the light. */
function orbGradient(
  id: string, cx: number, cy: number, r: number, hue: number, sat: number, opts: Shade = {},
): string {
  const fx = cx + (LIGHT.x - cx) * 0.42;
  const fy = cy + (LIGHT.y - cy) * 0.42;
  const { hi = 74, mid = 55, lo = 30, a = 1 } = opts;
  return (
    `<radialGradient id="${id}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"` +
    ` fx="${fx.toFixed(1)}" fy="${fy.toFixed(1)}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${hsl(hue, sat, hi, a)}"/>` +
    `<stop offset="0.55" stop-color="${hsl(hue, sat, mid, a)}"/>` +
    `<stop offset="1" stop-color="${hsl(hue - 6, Math.min(96, sat + 8), lo, a)}"/>` +
    `</radialGradient>`
  );
}

/** Base-to-tip shading for a petal, in the petal's own rotated frame. */
function petalGradient(id: string, length: number, hue: number, sat: number): string {
  return (
    `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="${-length}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${hsl(hue - 10, Math.min(96, sat + 10), 34)}"/>` +
    `<stop offset="0.5" stop-color="${hsl(hue, sat, 56)}"/>` +
    `<stop offset="1" stop-color="${hsl(hue + 12, sat, 76)}"/>` +
    `</linearGradient>`
  );
}

const petalPath = (L: number, w: number): string =>
  `M0 0 C ${w} ${(-L * 0.34).toFixed(1)}, ${(w * 0.62).toFixed(1)} ${(-L * 0.86).toFixed(1)}, 0 ${-L} ` +
  `C ${(-w * 0.62).toFixed(1)} ${(-L * 0.86).toFixed(1)}, ${-w} ${(-L * 0.34).toFixed(1)}, 0 0 Z`;

const vesicaPath = (L: number, w: number): string =>
  `M0 0 Q ${w} ${(-L * 0.5).toFixed(1)} 0 ${-L} Q ${-w} ${(-L * 0.5).toFixed(1)} 0 0 Z`;

function buildMark(family: TaskFamily, r: () => number, uid: string): { defs: string; body: string } {
  const base = Math.floor(r() * 360);
  const sat = 66 + r() * 20;
  const spin = r() * 360;
  const defs: string[] = [];
  const body: string[] = [];
  const hueAt = (i: number, n: number, spread: number) => base + (i / n) * spread;

  switch (family) {
    case 'bloom':
    case 'star': {
      const narrow = family === 'star';
      const n = narrow ? 5 + Math.floor(r() * 3) : 5 + Math.floor(r() * 4);
      const L = narrow ? 45 : 42;
      const w = narrow ? 8 + r() * 4 : 15 + r() * 6;
      const spread = (narrow ? 50 : 60) + r() * 80;
      for (let i = 0; i < n; i++) {
        const id = `${uid}p${i}`;
        defs.push(petalGradient(id, L, hueAt(i, n, spread), sat));
        body.push(
          `<g transform="rotate(${(spin + (360 / n) * i).toFixed(1)} 50 50) translate(50 50)">` +
          `<path d="${petalPath(L, w)}" fill="url(#${id})" opacity="0.95"/></g>`,
        );
      }
      const cid = `${uid}c`;
      defs.push(orbGradient(cid, 50, 50, narrow ? 12 : 13, base + spread * 0.5, sat, { hi: 88, mid: 65, lo: 39 }));
      body.push(`<circle cx="50" cy="50" r="${narrow ? 9.5 : 11}" fill="url(#${cid})"/>`);
      break;
    }
    case 'vesica': {
      const n = 6 + Math.floor(r() * 3);
      const L = 44;
      const w = 13 + r() * 5;
      const spread = 70 + r() * 90;
      for (let i = 0; i < n; i++) {
        const id = `${uid}v${i}`;
        defs.push(petalGradient(id, L, hueAt(i, n, spread), sat));
        body.push(
          `<g transform="rotate(${(spin + (360 / n) * i).toFixed(1)} 50 50) translate(50 50)">` +
          `<path d="${vesicaPath(L, w)}" fill="url(#${id})" opacity="0.9"/></g>`,
        );
      }
      break;
    }
    case 'flowerlife':
    case 'seed': {
      const tight = family === 'seed';
      const R = tight ? 15 + r() * 3 : 17 + r() * 3;
      const spread = (tight ? 100 : 120) + r() * 130;
      const centres: Array<[number, number]> = [[50, 50]];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i + (spin * Math.PI) / 180;
        centres.push([50 + R * Math.cos(angle), 50 + R * Math.sin(angle)]);
      }
      centres.forEach(([cx, cy], i) => {
        const id = `${uid}f${i}`;
        const hue = hueAt(i, centres.length, spread);
        defs.push(orbGradient(id, cx, cy, R, hue, sat, { a: tight ? 0.8 : 0.72, hi: 79, mid: 57, lo: 33 }));
        body.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${R.toFixed(1)}" fill="url(#${id})"/>`);
        if (tight) {
          body.push(
            `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${R.toFixed(1)}" fill="none"` +
            ` stroke="${hsl(hue + 10, sat, 86, 0.3)}" stroke-width="0.9"/>`,
          );
        }
      });
      break;
    }
    case 'mandala': {
      const rings = 2 + Math.floor(r() * 2);
      const spread = 90 + r() * 120;
      for (let k = 0; k < rings; k++) {
        const n = 6 + k * 4;
        const L = 20 + k * 15;
        const w = 7 + k * 3;
        for (let i = 0; i < n; i++) {
          const id = `${uid}m${k}_${i}`;
          defs.push(petalGradient(id, L, hueAt(k * n + i, rings * 10, spread), sat));
          body.push(
            `<g transform="rotate(${(spin + (360 / n) * i + k * 12).toFixed(1)} 50 50) translate(50 50)">` +
            `<path d="${petalPath(L, w)}" fill="url(#${id})" opacity="${(0.92 - k * 0.12).toFixed(2)}"/></g>`,
          );
        }
      }
      const cid = `${uid}mc`;
      defs.push(orbGradient(cid, 50, 50, 10, base, sat, { hi: 90, mid: 66, lo: 40 }));
      body.push(`<circle cx="50" cy="50" r="8" fill="url(#${cid})"/>`);
      break;
    }
    case 'planet': {
      const R = 30 + r() * 4;
      const tilt = -18 - r() * 18;
      const gid = `${uid}g`;
      defs.push(orbGradient(gid, 50, 50, R, base, sat, { hi: 80, mid: 52, lo: 22 }));
      body.push(`<circle cx="50" cy="50" r="${R.toFixed(1)}" fill="url(#${gid})"/>`);
      defs.push(`<clipPath id="${uid}pc"><circle cx="50" cy="50" r="${R.toFixed(1)}"/></clipPath>`);
      const bands = 2 + Math.floor(r() * 3);
      let banded = '';
      for (let i = 0; i < bands; i++) {
        const cy = 50 - R + ((i + 1) / (bands + 1)) * 2 * R;
        const h = 4 + r() * 7;
        const bid = `${uid}bd${i}`;
        const hue = base + 18 + i * 14;
        defs.push(
          `<linearGradient id="${bid}" x1="0" y1="0" x2="1" y2="0">` +
          `<stop offset="0" stop-color="${hsl(hue, sat, 40, 0)}"/>` +
          `<stop offset="0.35" stop-color="${hsl(hue, sat, 64, 0.55)}"/>` +
          `<stop offset="1" stop-color="${hsl(hue, sat, 44, 0)}"/></linearGradient>`,
        );
        banded += `<ellipse cx="50" cy="${cy.toFixed(1)}" rx="${R.toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="url(#${bid})"/>`;
      }
      body.push(`<g clip-path="url(#${uid}pc)">${banded}</g>`);
      const rid = `${uid}r`;
      defs.push(
        `<linearGradient id="${rid}" x1="0" y1="0" x2="1" y2="0">` +
        `<stop offset="0" stop-color="${hsl(base + 40, sat, 72, 0.85)}"/>` +
        `<stop offset="0.5" stop-color="${hsl(base + 55, sat, 86, 0.95)}"/>` +
        `<stop offset="1" stop-color="${hsl(base + 40, sat, 60, 0.75)}"/></linearGradient>`,
      );
      body.push(
        `<g transform="rotate(${tilt.toFixed(0)} 50 50)"><ellipse cx="50" cy="50" rx="${(R * 1.55).toFixed(1)}"` +
        ` ry="${(R * 0.36).toFixed(1)}" fill="none" stroke="url(#${rid})" stroke-width="${(3 + r() * 2.5).toFixed(1)}"/></g>`,
      );
      break;
    }
    case 'orbit': {
      const R = 17 + r() * 4;
      const spread = 110 + r() * 120;
      const gid = `${uid}o`;
      defs.push(orbGradient(gid, 50, 50, R, base, sat, { hi: 84, mid: 56, lo: 26 }));
      body.push(`<circle cx="50" cy="50" r="${R.toFixed(1)}" fill="url(#${gid})"/>`);
      const rings = 1 + Math.floor(r() * 2);
      for (let k = 0; k < rings; k++) {
        const rad = R + 10 + k * 11;
        const tilt = spin + k * 54;
        body.push(
          `<g transform="rotate(${tilt.toFixed(0)} 50 50)"><ellipse cx="50" cy="50" rx="${rad.toFixed(1)}"` +
          ` ry="${(rad * 0.42).toFixed(1)}" fill="none" stroke="${hsl(base + 40 + k * 20, sat, 78, 0.34)}" stroke-width="1.3"/></g>`,
        );
        const moons = 2 + Math.floor(r() * 3);
        for (let i = 0; i < moons; i++) {
          const angle = (360 / moons) * i + r() * 30;
          const mr = 3.4 + r() * 2.6;
          const mid = `${uid}mn${k}_${i}`;
          const mx = 50 + rad * Math.cos((angle * Math.PI) / 180);
          const my = 50 + rad * 0.42 * Math.sin((angle * Math.PI) / 180);
          const tr = (tilt * Math.PI) / 180;
          const rx = 50 + (mx - 50) * Math.cos(tr) - (my - 50) * Math.sin(tr);
          const ry = 50 + (mx - 50) * Math.sin(tr) + (my - 50) * Math.cos(tr);
          defs.push(orbGradient(mid, rx, ry, mr, hueAt(k * 3 + i, 6, spread), sat, { hi: 88, mid: 62, lo: 32 }));
          body.push(`<circle cx="${rx.toFixed(1)}" cy="${ry.toFixed(1)}" r="${mr.toFixed(1)}" fill="url(#${mid})"/>`);
        }
      }
      break;
    }
  }
  return { defs: defs.join(''), body: body.join('') };
}

/**
 * Render catalogue entry (family, index). Marks are decorative — the chip's
 * text label carries the meaning for assistive technology.
 */
export function taskMarkSvg(family: TaskFamily, index: number, size = 22): string {
  const seed = hashTaskId(`${taskMarkAddress(family, index)}|${family}`);
  const uid = `k${seed.toString(36)}`;
  const { defs, body } = buildMark(family, seeded(seed), uid);
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 100 100"` +
    ` xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true" focusable="false">` +
    `<defs>${defs}</defs>${body}</svg>`
  );
}

export interface ResolvedTaskMark {
  svg: string;
  family: TaskFamily;
  index: number;
  category: TaskCategory;
}

/** Resolve the mark for a real task: family from meaning, index from identity. */
export function taskMark(task: AgentTask, size = 22): ResolvedTaskMark {
  const category =
    task.category ?? classifyTask(task.title) ?? fallbackCategory(task.id);
  const family = CATEGORY_FAMILY[category];
  const index = hashTaskId(String(task.id ?? '')) % TASK_POOL_PER_FAMILY;
  return { svg: taskMarkSvg(family, index, size), family, index, category };
}

/** Unclassifiable work still gets a stable, evenly spread family. */
function fallbackCategory(id: string): TaskCategory {
  const categories = Object.keys(CATEGORY_FAMILY) as TaskCategory[];
  return categories[hashTaskId(`category|${String(id ?? '')}`) % categories.length];
}
