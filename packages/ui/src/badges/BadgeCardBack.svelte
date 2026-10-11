<script lang="ts">
  /**
   * The back of a badge card: the story of how it was earned. What the person
   * did, at the level they reached, then why it matters, and when. Turned to
   * by clicking the card on its stage (BadgeCardModal).
   *
   * Same dark card, frame and type as the face (BadgeCard.svelte), scaled
   * from the same 280px basis, so the two read as one card. With
   * `interactive` it has the face's hover too: it tilts toward the pointer
   * and a holographic light (pearl rainbow and etched rings) follows it,
   * kept soft so the story stays easy to read.
   */
  import type { ResolvedBadge } from "./badge-catalog.js";
  import { cardNumber, cardTierLabel } from "./badge-card.js";
  import { badgeStory } from "./badge-story.js";
  import { cardHover } from "./card-hover.js";

  interface Props {
    badge: ResolvedBadge;
    /** Whose card it is; none means your own, and the story speaks to you. */
    owner?: string | null;
    /** Tilt and light toward the pointer. */
    interactive?: boolean;
  }

  let { badge, owner = null, interactive = false }: Props = $props();

  const tierKey = $derived(badge.tier === "L" ? "L" : String(badge.tier));
  const story = $derived(badgeStory(badge, owner));
</script>

<div class="back t{tierKey}" class:interactive data-testid="badge-card-back" use:cardHover={interactive}>
  <span class="holo" aria-hidden="true"></span>
  <span class="glare" aria-hidden="true"></span>
  <div class="in">
    <div class="top">
      <svg class="logo" viewBox="0 0 577 330" aria-hidden="true"><path d="M176.594 7.54293H243.149V318.135H176.594V185.024H66.5555V318.135H0V7.54293H66.5555V118.469H176.594V7.54293Z"/><path d="M529.768 329.671L496.49 296.837C484.806 304.824 471.938 311.036 457.888 315.473C443.985 319.91 429.343 322.128 413.961 322.128C392.959 322.128 373.214 317.987 354.727 309.705C336.239 301.274 319.97 289.738 305.919 275.096C291.869 260.306 280.85 243.223 272.863 223.848C264.877 204.325 260.883 183.397 260.883 161.064C260.883 138.879 264.877 118.099 272.863 98.7239C280.85 79.201 291.869 62.0445 305.919 47.2544C319.97 32.4642 336.239 20.928 354.727 12.6455C373.214 4.21517 392.959 0 413.961 0C435.111 0 454.93 4.21517 473.417 12.6455C491.905 20.928 508.174 32.4642 522.225 47.2544C536.275 62.0445 547.22 79.201 555.059 98.7239C563.045 118.099 567.039 138.879 567.039 161.064C567.039 177.185 564.82 192.641 560.383 207.431C556.094 222.073 550.178 235.754 542.635 248.474L576.8 282.639L529.768 329.671ZM413.961 255.573C420.025 255.573 425.867 254.907 431.487 253.576C437.255 252.245 442.802 250.396 448.126 248.03L429.491 229.394L476.523 182.362L492.94 198.779C495.454 193.011 497.303 186.947 498.486 180.587C499.818 174.227 500.483 167.72 500.483 161.064C500.483 148.049 498.191 135.847 493.606 124.459C489.169 113.07 482.957 103.087 474.97 94.5087C466.984 85.7826 457.74 78.9791 447.239 74.0984C436.886 69.0698 425.793 66.5554 413.961 66.5554C402.129 66.5554 390.962 69.0698 380.461 74.0984C370.108 78.9791 360.939 85.7826 352.952 94.5087C344.965 103.087 338.679 113.07 334.094 124.459C329.657 135.847 327.439 148.049 327.439 161.064C327.439 174.079 329.657 186.355 334.094 197.892C338.679 209.28 344.965 219.337 352.952 228.063C360.939 236.642 370.108 243.371 380.461 248.252C390.962 253.133 402.129 255.573 413.961 255.573Z"/></svg>
      <span>{cardNumber(badge.def.id)}</span>
    </div>
    <div class="body">
      <div class="nm">{badge.def.name}</div>
      {#if story}
        <p class="did" data-testid="badge-card-story">{story.did}</p>
        <p class="why" data-testid="badge-card-why">{story.why}</p>
      {:else}
        <p class="did">{badge.def.crit}.</p>
      {/if}
    </div>
    <div class="bot"><b>{cardTierLabel(badge.tier)}</b><span>{story?.earned ?? ""}</span></div>
  </div>
  <span class="frame" aria-hidden="true"></span>
  <span class="rim" aria-hidden="true"></span>
</div>

<style>
  /* The card's own dark palette in both themes, as on the face. */
  .back {
    --u: calc(100cqw / 280);
    --title: #f4efe8;
    --body: rgba(244, 239, 232, 0.86);
    --sub: rgba(244, 239, 232, 0.55);
    --edge: rgba(255, 255, 255, 0.12);
    position: absolute; inset: 0; container-type: inline-size;
    border-radius: 4.3% / 3.07%; overflow: hidden;
    background:
      radial-gradient(ellipse 90% 60% at 50% 0%, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0) 70%),
      #17161A;
    color: var(--title);
    font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .back.t1 { --edge: #785037; }
  .back.t2 { --edge: #686b79; }
  .back.t3 { --edge: #917125; }
  .back.tL { --edge: transparent; }
  .in { position: absolute; inset: 0; display: flex; flex-direction: column; padding: calc(var(--u) * 22) calc(var(--u) * 24) calc(var(--u) * 21); }
  .top {
    display: flex; justify-content: space-between; align-items: center;
    padding: calc(var(--u) * 2) calc(var(--u) * 4) 0;
    font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace;
    font-size: calc(var(--u) * 9.5); letter-spacing: 0.16em; text-transform: uppercase; color: var(--sub);
  }
  .logo { display: block; width: auto; height: calc(var(--u) * 15); fill: currentColor; }
  /* The story sits in the middle of the card, read like a short note. */
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: calc(var(--u) * 10); padding: 0 calc(var(--u) * 4); }
  .nm { font-size: calc(var(--u) * 24); font-weight: 500; letter-spacing: -0.04em; line-height: 1.05; color: var(--title); }
  .did, .why { margin: 0; text-wrap: pretty; }
  .did { font-size: calc(var(--u) * 15); line-height: 1.4; color: var(--body); }
  .why { font-size: calc(var(--u) * 12); line-height: 1.45; color: var(--sub); }
  .bot {
    display: flex; justify-content: space-between; align-items: flex-end; gap: calc(var(--u) * 8);
    margin: calc(var(--u) * 10) calc(var(--u) * 4) 0; padding: calc(var(--u) * 8) 0 0;
    border-top: 1px solid var(--edge);
    font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace;
    font-size: calc(var(--u) * 8); letter-spacing: 0.14em; text-transform: uppercase; color: var(--sub);
  }
  .bot b { font-weight: 500; color: var(--title); }
  .back.tL .bot { border-image: linear-gradient(90deg, #3b22d0, #9a4ad6, #ec6f86, #fca58a) 1; }
  .frame { position: absolute; inset: calc(var(--u) * 8); border-radius: calc(var(--u) * 9); border: 1px solid var(--edge); pointer-events: none; }
  .back.tL .frame {
    border: 0; padding: 1px;
    background: linear-gradient(135deg, #3b22d0, #9a4ad6, #ec6f86, #fca58a);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
    mask-composite: exclude;
  }
  .rim { position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07); pointer-events: none; }
  .back.interactive { will-change: transform; }
  /* The holographic light, under the words: the foil's pearl rainbow
     (foil-gpu.ts pearlColor) with etched rings, only around the pointer. */
  .holo, .glare { position: absolute; inset: 0; pointer-events: none; opacity: 0; }
  .holo {
    mix-blend-mode: screen;
    background:
      repeating-radial-gradient(ellipse 100% 76% at 60% 55%, rgba(255, 255, 255, 0) 0 calc(var(--u) * 5), rgba(255, 255, 255, 0.55) calc(var(--u) * 5.5), rgba(255, 255, 255, 0) calc(var(--u) * 6.5)),
      linear-gradient(115deg, #f53a68, #6a3fe3 20%, #24d0df 40%, #aeca63 60%, #f53a68 80%, #6a3fe3);
    background-size: 100% 100%, 300% 300%;
    background-position: 0 0, var(--light-x, 60%) var(--light-y, 37%);
    -webkit-mask-image: radial-gradient(circle at var(--light-x, 60%) var(--light-y, 37%), #000 0, rgba(0, 0, 0, 0.45) 32%, rgba(0, 0, 0, 0) 62%);
    mask-image: radial-gradient(circle at var(--light-x, 60%) var(--light-y, 37%), #000 0, rgba(0, 0, 0, 0.45) 32%, rgba(0, 0, 0, 0) 62%);
  }
  .glare { background: radial-gradient(circle at var(--light-x, 60%) var(--light-y, 37%), rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0) 55%); }
  .back.interactive .holo { opacity: calc(var(--light, 0) * 0.5); }
  .back.interactive .glare { opacity: var(--light, 0); }
  .in { z-index: 1; }
</style>
