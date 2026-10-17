<script lang="ts">
  /**
   * Preview of the first-run team card (?view=team-card), the card the setup
   * bot's team block draws under its first message. No harness switch makes
   * the setup bot send that block, so the card is drawn here on its own, with
   * in-page answers (no network, no credentials).
   * ?state=
   *   invite    one pending invite and one existing company
   *   existing  existing companies only
   *   none      no companies: create or work solo
   *   error     a failed pick with Retry
   *   created   a create made a company but its reply failed: name locked, Retry
   *   settled   the one line the card settles into
   */
  import '../../../packages/ui/src/chat/chat-tokens.css';
  import TeamCard from '../../../packages/ui/src/chat/first-run/TeamCard.svelte';
  import type { FirstRunTeamOptions } from '../../../packages/ui/src/chat/first-run/team-step';

  const fixture = new URLSearchParams(window.location.search).get('state') ?? 'invite';
  const ACME = { companyUid: 'cmp_acme', slug: 'acme', name: 'Acme' };
  const PICKLE = { companyUid: 'cmp_pickle', slug: 'pickle', name: 'Pickle Labs' };

  const options: FirstRunTeamOptions =
    fixture === 'none'
      ? { invites: [], companies: [] }
      : fixture === 'existing'
        ? { invites: [], companies: [ACME, PICKLE] }
        : { invites: [ACME], companies: [PICKLE] };

  let picked = $state('');
</script>

<!-- .chat-shell carries the chat tokens the card reads in the app. -->
<div class="chat-shell" style="max-width: 640px; margin: 40px auto; padding: 16px 24px 16px 0;">
  <TeamCard
    {options}
    onpick={(pick) => (picked = JSON.stringify(pick))}
    error={fixture === 'error' || fixture === 'created' ? 'Something went wrong. Try again.' : null}
    onretry={() => (picked = 'retry')}
    settled={fixture === 'settled' ? 'Joined Acme' : null}
    createdName={fixture === 'created' ? 'Brine Labs' : null}
  />
  {#if picked}<p data-testid="picked" style="margin-top: 16px; font-size: 12px; opacity: 0.6;">{picked}</p>{/if}
</div>
