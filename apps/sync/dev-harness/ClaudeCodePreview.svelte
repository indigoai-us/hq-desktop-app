<script lang="ts">
  /**
   * Design-harness fixture for the New Bot Claude code paste-back
   * (?view=claude-code). Nothing here reaches the network.
   *
   *   ?claude=slow-ready (default)  the first code reaches the bot's machine before
   *                                 Claude is ready, so Claude's answer is not seen;
   *                                 the screen sends it once more and moves on
   *   ?claude=accepted              Claude accepts the first code
   *   ?claude=rejected              Claude does not accept the code
   *   ?claude=never                 the sign-in never shows: the screen times out
   *   ?claude=fail                  the request fails on the network (no resend)
   *   ?claude=invalid               the server turns the value down as not a Claude code
   *   ?loadingMs=N                  how long each code request takes (default 1500)
   */
  import NewBotTakeover from '../../../packages/ui/src/chat/create-bot/NewBotTakeover.svelte';
  import { beginWakingSession } from '../../../packages/ui/src/chat/create-bot/waking-model';

  const params = new URLSearchParams(window.location.search);
  const variant = params.get('claude') ?? 'slow-ready';
  const delayMs = Number(params.get('loadingMs')) || 1500;
  const PAIRING_URL = 'https://claude.ai/oauth/authorize?preview=1';

  let sends = 0;
  let signedIn = false;

  const session = {
    ...beginWakingSession({
      agentUid: 'agt_PREVIEWCLAUDE',
      channelId: 'chn_preview',
      companyUid: 'cmp_acme',
      name: 'Nova',
      brain: 'claude',
    }),
    approval: { provider: 'claude' as const, url: PAIRING_URL, code: '', capturedAt: new Date().toISOString() },
  };

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function getStatus(): Promise<unknown> {
    await wait(200);
    return {
      ok: true,
      value: {
        agent: { provider: 'claude' },
        ...(signedIn ? {} : { pairing: { url: PAIRING_URL } }),
        setupState: { phase: 'creating', steps: [{ name: 'codex-auth', status: signedIn ? 'done' : 'pending' }] },
      },
    };
  }

  async function submitClaudeLoginCode(): Promise<unknown> {
    sends += 1;
    await wait(delayMs);
    if (variant === 'fail') return { ok: false, code: 'network', message: 'Network error: operation timed out' };
    if (variant === 'invalid') return { ok: false, code: 'LOGIN_CODE_INVALID', status: 400, message: 'claude login code contains characters outside the URL-safe set' };
    const outcome =
      variant === 'rejected'
        ? 'rejected'
        : variant === 'slow-ready' && sends === 1
          ? 'unknown'
          : 'accepted';
    if (outcome === 'accepted' && variant !== 'never') signedIn = true;
    return {
      ok: true,
      value: { uid: 'agt_PREVIEWCLAUDE', ok: true, outcome, reason: 'Login failed: invalid_grant', at: new Date().toISOString() },
    };
  }
</script>

<NewBotTakeover
  oncancel={() => {}}
  wakingSession={session}
  {getStatus}
  retryAgent={async () => ({ ok: true })}
  {submitClaudeLoginCode}
  openExternal={() => true}
/>
