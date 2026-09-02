/**
 * The TypeScript half of one parser with two implementations.
 *
 * `crates/hq-desktop-core/src/agent_session/policy_digest.rs` `include_str!`s
 * the SAME fixture and pins the SAME shape (six slugs, four hard, `indigo`).
 * If either side drifts, one of the two suites goes red.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  EXCERPT_CAP,
  emptyPolicyDigest,
  mergePolicyDigest,
  parsePolicyDigest,
  policyCountLabel,
  type PolicyDigest,
} from './policy-digest';

const FIXTURE = readFileSync(
  new URL('./__fixtures__/hook-policy-reminder.txt', import.meta.url),
  'utf8',
);

const slugs = (digest: PolicyDigest): string[] => digest.entries.map((entry) => entry.slug);

function entry(digest: PolicyDigest, slug: string) {
  const found = digest.entries.find((candidate) => candidate.slug === slug);
  if (!found) throw new Error(`no entry for ${slug}`);
  return found;
}

describe('parsePolicyDigest — the shared fixture (pinned identically in Rust)', () => {
  it('parses to six distinct slugs, four hard, bound to indigo', () => {
    const digest = parsePolicyDigest(FIXTURE);
    expect(digest.company).toBe('indigo');
    expect(slugs(digest)).toEqual([
      'hq-git-discipline',
      'hq-share-session-urls-are-capabilities',
      'quiet-by-default-narration',
      'image-context-isolation',
      'credential-access-protocol',
      'indigo-no-client-data-in-commits',
    ]);
    expect(digest.entries.filter((e) => e.hard)).toHaveLength(4);
  });

  it('takes a full-text HARD policy’s first prose line as its excerpt', () => {
    const digest = parsePolicyDigest(FIXTURE);
    const git = entry(digest, 'hq-git-discipline');
    expect(git.hard).toBe(true);
    expect(git.excerpt).toBe(
      'Every git or gh mutation carries its own explicit repo anchor in the same command.',
    );
    const share = entry(digest, 'hq-share-session-urls-are-capabilities');
    expect(share.hard).toBe(true);
    expect(share.excerpt).toBe(
      'Never paste a share-session URL into a later turn, summary, journal, commit, or handoff.',
    );
  });

  it('takes the text after `applies here:` for a one-line policy', () => {
    const digest = parsePolicyDigest(FIXTURE);
    const quiet = entry(digest, 'quiet-by-default-narration');
    expect(quiet.hard).toBe(false);
    expect(quiet.excerpt).toBe(
      'Default to quiet, plain-language status; surface only completion, blockers, decisions, irreversible actions, and security signals.',
    );
    expect(entry(digest, 'credential-access-protocol').hard).toBe(true);
  });

  it('reads the company digest’s hard entries and dedupes against the reminder', () => {
    const digest = parsePolicyDigest(FIXTURE);
    const client = entry(digest, 'indigo-no-client-data-in-commits');
    expect(client.hard).toBe(true);
    expect(client.excerpt).toBe('Never commit client data, exports, or credentials to any repo.');
    expect(slugs(digest).filter((slug) => slug === 'hq-git-discipline')).toHaveLength(1);
  });
});

describe('parsePolicyDigest — edges', () => {
  it('is empty for text with no policies in it', () => {
    expect(parsePolicyDigest('')).toEqual(emptyPolicyDigest());
    expect(
      parsePolicyDigest('<journal-index>\n## Today\'s session journal\n</journal-index>\n'),
    ).toEqual(emptyPolicyDigest());
    expect(
      parsePolicyDigest('> Read the full rule(s) at `core/policies/{slug}.md`.').entries,
    ).toEqual([]);
  });

  it('keeps the parenthetical when a full-text policy has no body', () => {
    const digest = parsePolicyDigest('> Policy `lonely` (HARD — binding rule from `x.md`):\n');
    expect(digest.entries).toEqual([
      { slug: 'lonely', hard: true, excerpt: 'HARD — binding rule from `x.md`' },
    ]);
  });

  it('caps excerpts by code point with an ellipsis', () => {
    const digest = parsePolicyDigest(`> Policy \`big\` applies here: ${'é'.repeat(400)}`);
    const excerpt = digest.entries[0]!.excerpt;
    expect([...excerpt]).toHaveLength(EXCERPT_CAP);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('handles Windows line endings and leading indentation', () => {
    const digest = parsePolicyDigest('  > Policy `a` applies here: rule a\r\n  > Policy `b` (HARD): \r\n  > body b\r\n');
    expect(digest.entries).toEqual([
      { slug: 'a', hard: false, excerpt: 'rule a' },
      { slug: 'b', hard: true, excerpt: 'body b' },
    ]);
  });
});

describe('mergePolicyDigest', () => {
  it('dedupes by slug, keeps the first excerpt, and makes hard sticky', () => {
    const first = parsePolicyDigest('> Policy `a` applies here: first\n> Policy `b` applies here: b\n');
    const later = parsePolicyDigest(
      '> Policy `a` (HARD — binding rule from `a.md`):\n> a is now binding\n> Policy `c` applies here: c\n<company-policy-digest co="indigo">\n</company-policy-digest>\n',
    );
    const merged = mergePolicyDigest(first, later);
    expect(slugs(merged)).toEqual(['a', 'b', 'c']);
    expect(entry(merged, 'a')).toEqual({ slug: 'a', hard: true, excerpt: 'first' });
    expect(merged.company).toBe('indigo');
    // A merge with no company leaves the bound one alone.
    const again = mergePolicyDigest(merged, parsePolicyDigest('> Policy `d` applies here: d'));
    expect(again.company).toBe('indigo');
    expect(slugs(again)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never mutates either input', () => {
    const first = parsePolicyDigest('> Policy `a` applies here: first');
    const later = parsePolicyDigest('> Policy `a` (HARD): \n> Policy `z` applies here: z');
    const before = JSON.stringify({ first, later });
    mergePolicyDigest(first, later);
    expect(JSON.stringify({ first, later })).toBe(before);
  });
});

describe('policyCountLabel', () => {
  it('names the hard count only when there is one', () => {
    expect(policyCountLabel(emptyPolicyDigest())).toBe('0');
    expect(policyCountLabel(parsePolicyDigest('> Policy `a` applies here: a'))).toBe('1');
    expect(policyCountLabel(parsePolicyDigest(FIXTURE))).toBe('6 (4 hard)');
  });
});
