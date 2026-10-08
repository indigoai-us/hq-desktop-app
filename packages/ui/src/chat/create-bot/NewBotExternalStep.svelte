<script lang="ts">
  /**
   * "Connect it", from the Where step: how a bot that already runs somewhere
   * else joins HQ. It enrolls itself with a one-time code the CLI prints on
   * the machine that runs it, so this screen only shows the code's shape,
   * never a value. External bots are on paid plans.
   */
  import NewBotStepHead from "./NewBotStepHead.svelte";

  interface Props {
    onback: () => void;
    backTestId?: string;
  }

  let { onback, backTestId = "new-bot-external-back" }: Props = $props();
</script>

<div class="new-bot-create" data-testid="new-bot-external-step" role="group">
  <NewBotStepHead
    total={0}
    current={0}
    {onback}
    {backTestId}
    kicker="A bot you already run"
    lead="Connect a bot from"
    em="somewhere else."
  />
  <section class="new-bot-step new-bot-step--fit">
    <ol class="new-bot-external-steps" data-testid="chat-bot-where-external">
      <li>On the machine that runs it, run <code>hq agent enroll</code>.</li>
      <li>It prints a one-time code, like <span class="new-bot-mono" data-testid="chat-bot-external-enroll-mask">••••-••••</span>. Paste it there, not here.</li>
      <li>It joins your company, and its DM opens when it checks in.</li>
    </ol>
    <p class="new-bot-create-copy" data-testid="chat-bot-external-paid">External bots are part of the paid plans.</p>
  </section>
  <footer class="new-bot-create-foot">
    <button type="button" class="new-bot-create-submit" data-testid="new-bot-external-done" onclick={onback}>Done</button>
  </footer>
</div>
