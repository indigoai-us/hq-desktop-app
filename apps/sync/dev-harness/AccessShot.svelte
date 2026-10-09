<!--
  Company Groups and Grants panes on fixture data, for screenshots:
  ?view=access-shot&pane=groups|grants&state=ready|loading|failed&open=<folder>
  The fixture follows hq-pro's GET /secrets/{co}/groups and
  GET /files/{co}/acl/tree shapes; ids and names are fictional.
-->
<script lang="ts">
  import CompanySettingsPage from '../../../packages/ui/src/company/CompanySettingsPage.svelte';
  import '../../../packages/ui/src/home/tokens.css';

  const params = new URLSearchParams(window.location.search);
  const pane = params.get('pane') === 'grants' ? 'grants' : 'groups';
  const state = params.get('state') ?? 'ready';
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  const fail = (code: string) => ({ ok: false as const, reason: 'error' as const, code, message: code });
  const never = () => new Promise<never>(() => {});

  const groupNames = ['core', 'Dev', 'Dev Test', 'Exec', 'Finance', 'Marketing', 'Scout agent', 'Atlas agent', 'Delegation: Deacon'];
  const groups = groupNames.map((name) => ({
    groupId: `grp_${name.toLowerCase().replace(/[^a-z]+/g, '_')}`,
    name,
    ...(name.endsWith('agent') ? { description: `Single-agent ACL group for ${name.replace(' agent', '')}` } : {}),
  }));
  const people = ['Ana Ruiz', 'Bo Chen', 'Cy Okafor', 'Dee Park', 'Eli Moss', 'Fay Lund'];
  const identities = Object.fromEntries(
    people.map((name, i) => [`prs_${i}`, { uid: `prs_${i}`, type: 'person', name, email: `${name.split(' ')[0]!.toLowerCase()}@example.com` }]),
  );
  identities.agt_scout = { uid: 'agt_scout', type: 'agent', name: 'Scout' } as never;
  const e = (granteeType: string, granteeId: string, permission: string, sourcePrefix: string) => ({
    granteeType, granteeId, permission, grantedBy: 'prs_0', grantedAt: '2026-08-01T00:00:00.000Z', sourcePrefix,
  });
  const root = [e('group', 'grp_core', 'admin', '*'), e('person', 'prs_0', 'write', '*'), e('email', 'advisor@example.org', 'read', '*')];
  function children(folder: string, count: number) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const path = `${folder}/item-${String(i).padStart(3, '0')}/*`;
      const k = i % 6;
      if (k === 0) out.push(e('group', 'grp_exec', 'read', path));
      else if (k === 1) out.push(e('person', `prs_${i % people.length}`, 'write', path));
      else if (k === 2) out.push(e('person', 'agt_scout', 'read', path));
      else if (k === 3) out.push(e('email', `guest${i}@example.net`, 'read', path));
      else if (k === 4) out.push(e('group', 'grp_marketing', 'write', path));
      else out.push(e('company-wide', '', 'read', path));
    }
    return out;
  }
  const sizes: Record<string, number> = { agents: 37, knowledge: 79, projects: 216, skills: 370, meetings: 1200, policies: 13, workers: 7 };
  const tree = (prefix: string, kids: unknown[], nextCursor?: string | null) => ({
    prefix, direct: [], inherited: root, children: kids, directRow: null, effectivePermission: 'admin', identities,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });

  const files = {
    listDir: async () => ok([...Object.keys(sizes), 'sources', 'signals'].map((name) => ({ name, path: `companies/acme/${name}`, isDir: true, hasChildren: true }))),
    listAccessGroups: async () => (state === 'loading' ? never() : state === 'failed' ? fail('http-500') : ok({ groups })),
    getAccessTree: async (_uid: string, prefix: string, page?: { limit: number; cursor?: string }) => {
      if (state === 'loading') return never();
      if (state === 'failed') return fail('http-500');
      const folder = prefix.replace(/\/\*$/, '');
      if (folder === 'signals') return fail('http-502');
      if (folder === 'sources') return page ? fail('ACL_TREE_PAGINATION_DISABLED') : fail('ACL_TREE_RESPONSE_TOO_LARGE');
      const all = children(folder, sizes[folder] ?? 0);
      if (folder !== 'meetings') return ok(tree(prefix, all));
      if (!page) return fail('ACL_TREE_RESPONSE_TOO_LARGE');
      const start = page.cursor ? Number(atob(page.cursor)) : 0;
      const end = start + page.limit;
      return ok(tree(prefix, all.slice(start, end), end < all.length ? btoa(String(end)) : null));
    },
    // Grants pane: cross-company group grants, matching the console's revoked rows.
    listOutboundGroupGrants: async (_uid: string, groupId: string) => {
      if (state === 'loading') return never();
      if (state === 'failed') return fail('http-500');
      const rows = [
        { groupId: 'grp_scout_agent', sourceCompanyUid: 'cmp_acme', targetCompanyUid: 'cmp_kept', role: 'admin', status: 'revoked', targetCompanyName: 'Keptwork' },
        { groupId: 'grp_dev_test', sourceCompanyUid: 'cmp_acme', targetCompanyUid: 'cmp_vyg', role: 'admin', status: 'revoked', targetCompanyName: 'VYG' },
        { groupId: 'grp_dev_test', sourceCompanyUid: 'cmp_acme', targetCompanyUid: 'cmp_01GONE', role: 'admin', status: 'revoked' },
        ...(params.get('active') ? [{ groupId: 'grp_exec', sourceCompanyUid: 'cmp_acme', targetCompanyUid: 'cmp_kept', role: 'guest', status: 'active', targetCompanyName: 'Keptwork' }] : []),
      ];
      return ok({ grants: rows.filter((r) => r.groupId === groupId) });
    },
    listInboundGroupGrants: async () => (state === 'loading' ? never() : state === 'failed' ? fail('http-500') : ok({ grants: [] })),
    createGroupGrant: async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return ok({ grant: {} });
    },
    revokeGroupGrant: async () => ok({ grant: {} }),
  };
  const targets = [
    { uid: 'cmp_acme', label: 'Acme', eligible: true },
    { uid: 'cmp_kept', label: 'Keptwork', eligible: true },
    { uid: 'cmp_vyg', label: 'VYG', eligible: true },
    { uid: 'cmp_other', label: 'Northwind', eligible: false },
  ];
</script>

<div class="frame" data-theme="dark">
  <CompanySettingsPage slug="acme" companyLabel="Acme" companyUid="cmp_acme" section={pane} role="Owner" files={files as never} {targets} />
</div>

<style>
  .frame { width: 960px; height: 720px; background: var(--bg, #141414); color: var(--t1, #eee); }
</style>
