// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CompanyProjectsPage from '../../src/desktop-alt/pages/CompanyProjectsPage.svelte';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../../src/desktop-alt/lib/sessions-store.svelte', () => ({
  sessionsStore: { sessions: [] },
  startSessionsStore: vi.fn(),
}));

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  invokeMock.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

describe('project person identity', () => {
  it('does not split the signed-in owner when cloud member hydration is unavailable', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_local_projects') {
        return [
          {
            id: 'git-authored',
            title: 'Git authored project',
            company: 'machine-learning-strategies',
            status: 'planned',
            prdPath:
              'companies/machine-learning-strategies/projects/git-authored/prd.json',
            creatorFallback: 'Scott Thielmann',
            storyCount: 0,
            storiesComplete: 0,
          },
          {
            id: 'cloud-authored',
            title: 'Cloud authored project',
            company: 'machine-learning-strategies',
            status: 'planned',
            prdPath:
              'companies/machine-learning-strategies/projects/cloud-authored/prd.json',
            storyCount: 0,
            storiesComplete: 0,
          },
        ];
      }
      if (command === 'get_company_project_creators') {
        return [
          {
            id: 'cloud-authored',
            prdPath:
              'companies/machine-learning-strategies/projects/cloud-authored/prd.json',
            creator: 'scott@mlstrategies.us',
          },
        ];
      }
      if (command === 'get_local_company_goals') {
        return { objectives: [], initiatives: [] };
      }
      if (command === 'get_signed_in_project_person') {
        return {
          personUid: 'cognito_scott',
          email: 'scott@mlstrategies.us',
          displayName: 'Scott Thielmann',
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    component = mount(CompanyProjectsPage, {
      target: host,
      props: {
        slug: 'machine-learning-strategies',
        companyUid: null,
      },
    });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="project-row"]')).toHaveLength(2);
    });

    const ownerSelect = host.querySelector<HTMLSelectElement>(
      '[data-testid="portfolio-owner-filter"]',
    )!;
    expect([...ownerSelect.options].slice(1).map((option) => option.textContent)).toEqual([
      'Scott Thielmann',
    ]);
  });

  it('coalesces a member name and email into one filter identity and both projects', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_local_projects') {
        return [
          {
            id: 'git-authored',
            title: 'Git authored project',
            company: 'machine-learning-strategies',
            status: 'planned',
            prdPath:
              'companies/machine-learning-strategies/projects/git-authored/prd.json',
            creatorFallback: 'Scott Thielmann',
            storyCount: 0,
            storiesComplete: 0,
          },
          {
            id: 'cloud-authored',
            title: 'Cloud authored project',
            company: 'machine-learning-strategies',
            status: 'planned',
            prdPath:
              'companies/machine-learning-strategies/projects/cloud-authored/prd.json',
            storyCount: 0,
            storiesComplete: 0,
          },
        ];
      }
      if (command === 'get_company_project_creators') {
        return [
          {
            id: 'cloud-authored',
            prdPath:
              'companies/machine-learning-strategies/projects/cloud-authored/prd.json',
            creator: 'scott@mlstrategies.us',
          },
        ];
      }
      if (command === 'get_local_company_goals') {
        return { objectives: [], initiatives: [] };
      }
      if (command === 'list_company_members') {
        return {
          contacts: [
            {
              personUid: 'prs_scott',
              email: 'scott@mlstrategies.us',
              displayName: 'Scott Thielmann',
            },
          ],
        };
      }
      if (command === 'get_signed_in_project_person') {
        return {
          personUid: 'cognito_scott',
          email: 'scott@mlstrategies.us',
          displayName: 'Scott Thielmann',
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    component = mount(CompanyProjectsPage, {
      target: host,
      props: {
        slug: 'machine-learning-strategies',
        companyUid: 'co_mls',
      },
    });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="project-row"]')).toHaveLength(2);
    });

    const ownerSelect = host.querySelector<HTMLSelectElement>(
      '[data-testid="portfolio-owner-filter"]',
    );
    expect(ownerSelect).toBeTruthy();
    const personOptions = [...(ownerSelect?.options ?? [])].slice(1);
    expect(personOptions.map((option) => option.textContent)).toEqual([
      'Scott Thielmann',
    ]);
    expect(host.textContent).not.toContain('scott@mlstrategies.us');

    ownerSelect!.value = personOptions[0].value;
    ownerSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="project-row"]')).toHaveLength(2);
    });
    const provenanceLines = [
      ...host.querySelectorAll('[data-testid="project-card-provenance"]'),
    ];
    expect(provenanceLines).toHaveLength(2);
    expect(
      provenanceLines.every((line) => line.textContent?.includes('Scott Thielmann')),
    ).toBe(true);
  });

  it('keeps two members with the same display name as separate filter options', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_local_projects') {
        return [
          {
            id: 'alex-one-project',
            title: 'First Alex project',
            company: 'acme',
            status: 'planned',
            prdPath: 'companies/acme/projects/alex-one-project/prd.json',
            storyCount: 0,
            storiesComplete: 0,
          },
          {
            id: 'alex-two-project',
            title: 'Second Alex project',
            company: 'acme',
            status: 'planned',
            prdPath: 'companies/acme/projects/alex-two-project/prd.json',
            storyCount: 0,
            storiesComplete: 0,
          },
        ];
      }
      if (command === 'get_company_project_creators') {
        return [
          {
            id: 'alex-one-project',
            prdPath: 'companies/acme/projects/alex-one-project/prd.json',
            creator: 'alex.one@example.com',
          },
          {
            id: 'alex-two-project',
            prdPath: 'companies/acme/projects/alex-two-project/prd.json',
            creator: 'alex.two@example.com',
          },
        ];
      }
      if (command === 'get_local_company_goals') {
        return { objectives: [], initiatives: [] };
      }
      if (command === 'list_company_members') {
        return {
          contacts: [
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
          ],
        };
      }
      if (command === 'get_signed_in_project_person') {
        return {
          personUid: 'cognito_me',
          email: 'me@example.com',
          displayName: 'Current User',
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    component = mount(CompanyProjectsPage, {
      target: host,
      props: { slug: 'acme', companyUid: 'co_acme' },
    });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="project-row"]')).toHaveLength(2);
      const options = [
        ...host.querySelectorAll<HTMLOptionElement>(
          '[data-testid="portfolio-owner-filter"] option',
        ),
      ].slice(1);
      expect(options.map((option) => option.textContent)).toEqual([
        'Alex · alex.one@example.com',
        'Alex · alex.two@example.com',
      ]);
    });

    const ownerSelect = host.querySelector<HTMLSelectElement>(
      '[data-testid="portfolio-owner-filter"]',
    )!;
    ownerSelect.selectedIndex = 1;
    ownerSelect.value = ownerSelect.options[1].value;
    expect(ownerSelect.value).toBe('person:prs_alex_one');
    ownerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="project-row"]')).toHaveLength(1);
      expect(host.textContent).toContain('First Alex project');
      expect(host.textContent).not.toContain('Second Alex project');
    });
  });
});
