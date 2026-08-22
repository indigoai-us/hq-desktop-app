import { describe, expect, it } from 'vitest';
import {
  buildProjectPersonDirectory,
  normalizeProjectMembers,
  resolveProjectPerson,
} from './project-people';

describe('project people', () => {
  it('resolves a member name and email to the same canonical person UID', () => {
    const members = normalizeProjectMembers({
      contacts: [
        {
          personUid: 'prs_scott',
          email: 'scott@mlstrategies.us',
          displayName: 'Scott Thielmann',
        },
      ],
    });
    const directory = buildProjectPersonDirectory(members);

    expect(resolveProjectPerson('Scott Thielmann', directory)).toEqual({
      key: 'person:prs_scott',
      label: 'Scott Thielmann',
    });
    expect(resolveProjectPerson('SCOTT@MLSTRATEGIES.US', directory)).toEqual({
      key: 'person:prs_scott',
      label: 'Scott Thielmann',
    });
  });

  it('merges signed-in and company records with the same exact email', () => {
    const members = normalizeProjectMembers([
      {
        personUid: 'prs_scott',
        email: 'scott@mlstrategies.us',
        displayName: 'Scott Thielmann',
      },
      {
        personUid: 'cognito_scott',
        email: 'SCOTT@MLSTRATEGIES.US',
        displayName: 'Scott Thielmann',
      },
    ]);

    expect(members).toEqual([
      {
        personUid: 'prs_scott',
        email: 'scott@mlstrategies.us',
        displayName: 'Scott Thielmann',
      },
    ]);
  });

  it('keeps the signed-in UID stable when its company record hydrates later', () => {
    const members = normalizeProjectMembers([
      {
        personUid: 'cognito_scott',
        email: 'scott@mlstrategies.us',
        displayName: 'Scott Thielmann',
      },
      {
        personUid: 'prs_scott',
        email: 'SCOTT@MLSTRATEGIES.US',
        displayName: 'Scott Thielmann',
      },
    ]);

    expect(resolveProjectPerson('Scott Thielmann', buildProjectPersonDirectory(members))).toEqual({
      key: 'person:cognito_scott',
      label: 'Scott Thielmann',
    });
  });

  it('never renders an unresolved raw person UID', () => {
    expect(resolveProjectPerson('prs_01ABC-123_test', buildProjectPersonDirectory([]))).toBeNull();
  });

  it('resolves a known raw person UID to the member label', () => {
    const directory = buildProjectPersonDirectory([
      {
        personUid: 'prs_scott',
        email: 'scott@mlstrategies.us',
        displayName: 'Scott Thielmann',
      },
    ]);

    expect(resolveProjectPerson('prs_scott', directory)).toEqual({
      key: 'person:prs_scott',
      label: 'Scott Thielmann',
    });
  });

  it('keeps different members with the same display name distinct', () => {
    const members = normalizeProjectMembers([
      {
        personUid: 'prs_alex_one',
        email: 'alex.one@example.com',
        displayName: 'Alex',
      },
      {
        personUid: 'prs_alex_two',
        email: 'alex.two@example.com',
        displayName: 'Alex',
      },
    ]);
    const directory = buildProjectPersonDirectory(members);

    expect(resolveProjectPerson('alex.one@example.com', directory)).toEqual({
      key: 'person:prs_alex_one',
      label: 'Alex · alex.one@example.com',
    });
    expect(resolveProjectPerson('alex.two@example.com', directory)).toEqual({
      key: 'person:prs_alex_two',
      label: 'Alex · alex.two@example.com',
    });
    expect(resolveProjectPerson('Alex', directory)).toEqual({
      key: 'label:alex',
      label: 'Alex',
    });
  });
});
