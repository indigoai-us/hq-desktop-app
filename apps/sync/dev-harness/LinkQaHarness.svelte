<script lang="ts">
  // Mirrors ChannelConversation's link wiring: rendered body + hovercard controller.
  import LinkHovercard from '../../../packages/ui/src/chat/messaging/LinkHovercard.svelte';
  import { LinkHovercardController, copyLinkToClipboard } from '../../../packages/ui/src/chat/messaging/linkHovercardController.svelte';
  import { renderMessageBodyMarkdown } from '../../../packages/ui/src/common/messageMarkdown';

  const cal =
    'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Sol+Stingray+swim+(Nov+4:30)&dates=20261027T163000/20261027T170000&ctz=America/Denver&location=Berthoud+Recreation+Center&recur=RRULE:FREQ%3DWEEKLY;BYDAY%3DTU,TH;UNTIL%3D20261120&details=Stingrays+swim+team';
  const body = [
    'Found Sol a spot in the Nov 4:30 group.',
    '',
    'Register now: https://apps.daysmartrecreation.com/dash/x/#/online/berthoud/teams/7037',
    '',
    `Add to calendar: ${cal}`,
    '',
    'PR: https://github.com/indigoai-us/hq-desktop-app/pull/1514',
    'Repo: https://github.com/indigoai-us/hq-desktop-app',
    'Preview: https://hq-console-git-corey-links-indigoai.vercel.app',
    'Read [the docs](https://example.com/docs) first.',
  ].join('\n');

  const linkCards = new LinkHovercardController();
  $effect(() => linkCards.connect());
  (window as any).__opened = [];
</script>

<div class="chat-shell" style="padding: 24px; width: 560px; min-height: 100vh; background: var(--bg, var(--pop-bg)); color: var(--text, inherit); font-size: 14px; line-height: 1.5;">
  <div style="font-weight: 500; margin-bottom: 4px;">Izzy</div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="message-body"
    data-testid="message-body"
    onclick={(e) => { const a = (e.target as Element).closest('a'); if (a) { e.preventDefault(); linkCards.hide(); (window as any).__opened.push(a.getAttribute('href')); } }}
    onkeydown={(e) => { linkCards.onkeydown(e); }}
    onpointerover={linkCards.onpointerover}
    onpointerout={linkCards.onpointerout}
    onfocusin={linkCards.onfocusin}
    onfocusout={linkCards.onfocusout}
  >
    {@html renderMessageBodyMarkdown(body, linkCards.pageTitles())}
    {#if linkCards.card}
      <LinkHovercard
        id={linkCards.id}
        href={linkCards.card.href}
        preview={linkCards.card.preview}
        pageTitle={linkCards.pageTitle}
        rect={linkCards.card.rect}
        onopen={(url) => { linkCards.hide(); (window as any).__opened.push(url); }}
        oncopy={copyLinkToClipboard}
        onpointerenter={linkCards.hold}
        onpointerleave={linkCards.scheduleClose}
      />
    {/if}
  </div>
  <button data-testid="after">after</button>
</div>
