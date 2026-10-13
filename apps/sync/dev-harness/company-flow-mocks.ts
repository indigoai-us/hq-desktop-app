/**
 * `?view=onboarding&company=create`: answers for the first-run company step
 * inside the full welcome flow (the real OnboardingWizard wrapper), so the
 * step can be previewed and measured where it ships rather than on its own.
 * A brand-new person: no memberships, no invites, every handle free.
 * `&companyDelay=<ms>` slows the create-company card fetch, as on a real
 * network, so the step first shows "Getting things ready…" and then grows.
 * `&connectors=ok|fail` finds two Claude Desktop connectors, so the connector
 * import is offered once a company is made (never after Skip for now), and
 * the import succeeds (ok) or fails (fail) to show the Try again screen.
 */
const CREATE_COMPANY_CARD = {
  v: 1,
  type: 'lifecycle_card',
  kind: 'create_company',
  cardId: 'card_create_company',
  state: 'open',
  title: 'Name your company',
  summary: null,
  fields: [
    { id: 'name', label: 'Company name', control: 'text', required: true, value: '' },
    {
      id: 'slug',
      label: 'Company handle',
      control: 'text',
      required: true,
      value: '',
      constraints: { pattern: '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$', minLength: 3, maxLength: 40, description: 'Lowercase letters, numbers and dashes.' },
    },
    { id: 'website', label: "Website (optional) — we'll use its icon for your company", control: 'text', required: false, value: '' },
  ],
  actions: [{ id: 'submit', label: 'Create company', style: 'primary' }],
  viewer: { canAct: true },
};

export function companyFlowEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('view') === 'onboarding' && params.get('company') === 'create';
}

const NOT_HANDLED = Symbol('not-handled');

function connectorSwitch(): 'ok' | 'fail' | null {
  const value = new URLSearchParams(window.location.search).get('connectors');
  return value === 'ok' || value === 'fail' ? value : null;
}

function cardDelayMs(): number {
  const raw = Number(new URLSearchParams(window.location.search).get('companyDelay') ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** The answer for `cmd`, or NOT_HANDLED to fall through to the usual mocks. */
export async function companyFlowAnswer(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (cmd === 'fetch_channel' && cardDelayMs() > 0) {
    await new Promise((resolve) => setTimeout(resolve, cardDelayMs()));
  }
  switch (cmd) {
    case 'detect_claude_desktop_connectors':
      if (!connectorSwitch()) return NOT_HANDLED;
      return { present: true, count: 2, outcome: 'servers_detected', inspectedSources: 'claude_desktop_config' };
    case 'import_claude_desktop_connectors':
      if (!connectorSwitch()) return NOT_HANDLED;
      return connectorSwitch() === 'ok'
        ? { ok: true, message: 'Imported 2 connectors.', errorCategory: 'unknown' }
        : {
            ok: false,
            message: 'hq: No active company memberships found. Use --company <slug> to specify.',
            errorCategory: 'exit-nonzero',
          };
    case 'list_syncable_workspaces':
      return { workspaces: [], cloudReachable: true, error: null, hqFolderPath: '/Users/preview/hq' };
    case 'web_visitor_anon_id':
      return null;
    case 'run_card_action':
      if (args?.cardId === 'companies_summary') throw new Error('[not_found] Request failed (status 404)');
      return { state: 'done', companyUid: 'cmp_preview', companyChannelId: 'ch_preview' };
    case 'fetch_channel':
      return {
        channelId: 'setup',
        messages: [{ eventId: 'evt_card', createdAt: new Date().toISOString(), messageKind: 'system', systemEvent: CREATE_COMPANY_CARD }],
      };
    case 'check_company_slug': {
      const slug = String(args?.slug ?? '');
      return { valid: true, available: true, normalized: slug, suggestion: null, reasons: [] };
    }
    case 'activate_company_cloud':
      return { activated: true };
    case 'run_company_tab_action':
      return { state: 'done' };
    case 'hq_pro_fetch': {
      const url = typeof args?.url === 'string' ? args.url : '';
      if (url === '/membership/me' || url.startsWith('/membership/me?')) {
        return { status: 200, body: JSON.stringify({ memberships: [] }) };
      }
      if (url === '/membership/pending-by-email') return { status: 200, body: JSON.stringify({ invites: [] }) };
      if (url.startsWith('/entity/')) {
        return { status: 200, body: JSON.stringify({ entity: { status: 'active', bucketName: 'hq-vault-preview' } }) };
      }
      return NOT_HANDLED;
    }
    default:
      return NOT_HANDLED;
  }
}

export { NOT_HANDLED };
