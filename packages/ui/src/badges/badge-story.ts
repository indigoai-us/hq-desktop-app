/**
 * The story on the back of a badge card: what the person did to earn it, at
 * the level they reached, and why it matters. Written to the person when it
 * is their own card ("You put 10 deploys live.") and about them when it is
 * someone else's ("Maya put 10 deploys live."). A shared post of your own
 * card is in your voice ("I put 10 deploys live.").
 *
 * Pure words. Nothing here touches the DOM.
 */

import type { BadgeTier, ResolvedBadge } from "./badge-catalog.js";
import { cardDate } from "./badge-card.js";

/** The words a story needs for the person it is about. */
export interface StoryVoice {
  /** "You" / "Maya": starts a sentence. */
  Subject: string;
  /** "you" / "Maya" / "me": inside a sentence, as the object. */
  subject: string;
  /** "your" / "Maya's" / "my": when the person has not been named yet in the sentence. */
  possessive: string;
  /** "your" / "their" / "my": after the person is named ("Maya put their first deploy live."). */
  their: string;
  /** "Your" / "Maya's": starts a sentence. */
  Possessive: string;
}

/** "you": your own card; "I": a post of your own card; "they": someone else's card. */
export type StoryPerson = "second" | "first" | "third";

/** Second person with no owner (your own card), otherwise the owner's first name. First person for a post. */
export function storyVoice(owner: string | null | undefined, person: StoryPerson = "second"): StoryVoice {
  if (person === "first") return { Subject: "I", subject: "me", possessive: "my", their: "my", Possessive: "My" };
  const first = owner?.trim().split(/\s+/u)[0] ?? "";
  if (!first) return { Subject: "You", subject: "you", possessive: "your", their: "your", Possessive: "Your" };
  const possessive = /s$/iu.test(first) ? `${first}'` : `${first}'s`;
  // "their": a name never tells us someone's pronouns.
  return { Subject: first, subject: first, possessive, their: "their", Possessive: possessive };
}

type Line = (v: StoryVoice) => string;

interface StoryDef {
  /** What they did, per level reached: Bronze, Silver, Gold. One entry for single-level badges. */
  did: readonly [Line] | readonly [Line, Line, Line];
  /** Why it matters. */
  why: Line;
}

const STORIES: Readonly<Record<string, StoryDef>> = {
  founding: {
    did: [(v) => `${v.Subject} joined HQ before the public launch, while it was still being built.`],
    why: () => "This badge can't be earned anymore. It belongs to the people whose early use and feedback shaped HQ.",
  },
  founder: {
    did: [(v) => `${v.Subject} started a company in HQ, and a teammate joined to work there together.`],
    why: (v) => `Every company in HQ starts with one person setting it up. This one started with ${v.subject}.`,
  },
  bughunter: {
    did: [
      (v) => `${v.Subject} sent 3 reports that helped improve HQ.`,
      (v) => `${v.Subject} sent 10 reports that helped improve HQ.`,
      (v) => `${v.Subject} sent 25 reports that helped improve HQ.`,
    ],
    why: () => "Every report shows the team something to fix or make better. HQ is sharper for each one.",
  },
  liftoff: {
    did: [
      (v) => `${v.Subject} put 5 deploys live.`,
      (v) => `${v.Subject} put 50 deploys live.`,
      (v) => `${v.Subject} put 250 deploys live.`,
    ],
    why: () => "A deploy that goes live is work people can use, not work waiting on a branch.",
  },
  poweruser: {
    did: [
      (v) => `${v.Subject} ran skills 100 times.`,
      (v) => `${v.Subject} ran skills 500 times.`,
      (v) => `${v.Subject} ran skills 2,500 times.`,
    ],
    why: () => "Skills turn repeat work into one step. Running them this often makes HQ part of the daily routine.",
  },
  toolbox: {
    did: [
      (v) => `${v.Subject} used 5 different skills.`,
      (v) => `${v.Subject} used 15 different skills.`,
      (v) => `${v.Subject} used 40 different skills.`,
    ],
    why: () => "Knowing which skill fits which job is what makes the work feel light.",
  },
  maker: {
    did: [
      (v) => `${v.Subject} wrote 5 skills.`,
      (v) => `${v.Subject} wrote 50 skills.`,
      (v) => `${v.Subject} wrote 250 skills.`,
    ],
    why: () => "Something written once now helps the whole team, every time it runs.",
  },
  teambuilder: {
    did: [
      (v) => `3 teammates joined HQ from ${v.possessive} invites.`,
      (v) => `10 teammates joined HQ from ${v.possessive} invites.`,
      (v) => `25 teammates joined HQ from ${v.possessive} invites.`,
    ],
    why: () => "A team works better in one place. Every invite brings someone in.",
  },
  fleet: {
    did: [
      (v) => `${v.Subject} created ${v.their} first agent.`,
      (v) => `${v.Subject} created 5 agents.`,
      (v) => `${v.Subject} created 15 agents.`,
    ],
    why: () => "Agents take on work in the background, so people can spend their time on what needs them.",
  },
  connector: {
    did: [
      (v) => `${v.Subject} connected 3 apps to HQ.`,
      (v) => `${v.Subject} connected 6 apps to HQ.`,
      (v) => `${v.Subject} connected 10 apps to HQ.`,
    ],
    why: () => "Each connected app brings its context into HQ, so less gets copied around by hand.",
  },
  sharer: {
    did: [
      (v) => `${v.Subject} shared ${v.their} first file with a teammate.`,
      (v) => `${v.Subject} shared 10 files with teammates.`,
      (v) => `${v.Subject} shared 50 files with teammates.`,
    ],
    why: () => "Shared files keep everyone working from the same page.",
  },
  regular: {
    did: [
      (v) => `${v.Subject} came back to HQ for a second week.`,
      (v) => `${v.Subject} kept coming back to HQ for a full month.`,
      (v) => `${v.Subject} kept coming back to HQ for six months.`,
    ],
    why: () => "Coming back is the best sign that HQ has earned its place in the day.",
  },
  shipit: {
    did: [
      (v) => `${v.Subject} shipped ${v.their} first project.`,
      (v) => `${v.Subject} shipped 5 projects.`,
      (v) => `${v.Subject} shipped 20 projects.`,
    ],
    why: () => "Shipping is the point. Each of these made it all the way out the door.",
  },
  closer: {
    did: [
      (v) => `${v.Subject} completed 10 stories.`,
      (v) => `${v.Subject} completed 100 stories.`,
      (v) => `${v.Subject} completed 500 stories.`,
    ],
    why: () => "Stories are where plans turn into finished work, one done at a time.",
  },
  onfire: {
    did: [
      (v) => `${v.Subject} used HQ 7 days in a row.`,
      (v) => `${v.Subject} used HQ 30 days in a row.`,
      (v) => `${v.Subject} used HQ 100 days in a row.`,
    ],
    why: () => "A streak like this means HQ is part of the routine, day after day.",
  },
};

const LEVEL_INDEX: Readonly<Record<string, number>> = { 1: 0, 2: 1, 3: 2, L: 2 };

export interface BadgeStory {
  /** What they did to earn it, at the level reached. */
  did: string;
  /** Why it matters. */
  why: string;
  /** "Earned Oct 6, 2026". */
  earned: string;
}

/** The story for a card, or null for a badge the stories do not cover. */
export function badgeStory(badge: ResolvedBadge, owner?: string | null, person: StoryPerson = "second"): BadgeStory | null {
  const def = STORIES[badge.def.id];
  if (!def) return null;
  const voice = storyVoice(owner, person);
  const at = def.did.length === 1 ? 0 : LEVEL_INDEX[String(badge.tier as BadgeTier)] ?? 0;
  return { did: def.did[at](voice), why: def.why(voice), earned: `Earned ${cardDate(badge.earnedAt)}` };
}

/** Every badge id that has a story; the catalog test checks this covers them all. */
export const STORY_IDS: readonly string[] = Object.keys(STORIES);
