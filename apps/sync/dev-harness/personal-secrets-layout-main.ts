import { mount } from 'svelte';
import PersonalRailPage from '../../../packages/ui/src/personal/PersonalRailPage.svelte';
import { configureCompanyApi } from '../../../packages/ui/src/company/company-store.svelte';
import '../src/styles/design-system.css';
import '../src/styles/popover.css';
import '../src/desktop-alt/styles/desktop-alt.css';

// QA-099 stage: 19 personal rows with long names, the shape the desktop
// transport returns ({ env, items: [{ key, upd, rot }] }).
const items = Array.from({ length: 19 }, (_, i) => ({
  key: `PERSONAL_SERVICE_${String(i + 1).padStart(2, '0')}_API_TOKEN_LONG_NAME`,
  upd: '2026-09-20T00:00:00Z',
  rot: '',
}));

configureCompanyApi({
  getSecrets: async () => ({ ok: true, value: [{ env: 'default', items }] }),
} as never);

document.documentElement.setAttribute('data-window', 'desktop-alt');
const width = Number(new URLSearchParams(location.search).get('w') ?? '1000');
const target = document.getElementById('personal-secrets-layout')!;
target.style.width = `${width}px`;
target.style.height = '800px';
mount(PersonalRailPage, { target, props: { page: 'secrets' } });
