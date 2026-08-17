<script lang="ts">
  type Filter = 'Unread'|'Mentions'|'All';
  type Item = { id:string; person:string; context:string; preview:string; time:string; kind:string; unread:number; mention?:boolean; initials:string };
  const items: Item[] = [
    { id:'release', person:'Jacob Posel, Alan Saura', context:'Release coordination', preview:'Alan: Verified on a clean Windows install.', time:'2m', kind:'Group DM', unread:3, mention:true, initials:'3' },
    { id:'core', person:'hq-core', context:'Indigo', preview:'@Corey updater artifacts are ready for review.', time:'12m', kind:'Channel', unread:6, mention:true, initials:'#' },
    { id:'yousuf', person:'Yousuf Kalim', context:'Direct message', preview:'I picked up the billing agent follow-up.', time:'1h', kind:'DM', unread:1, initials:'YK' },
    { id:'agent', person:'Your agent', context:'Personal', preview:'Three decisions are waiting for you.', time:'2h', kind:'Agent', unread:2, initials:'⚡' },
    { id:'wins', person:'hq-wins', context:'Indigo', preview:'HQ Desktop v0.10.39 is public.', time:'3h', kind:'Channel', unread:0, initials:'#' },
  ];
  let filter = $state<Filter>('Unread'); let selected = $state('release'); let caughtUp = $state(false); let draft = $state(''); let sent = $state<string[]>([]);
  const visible = $derived(items.filter(i => filter === 'All' || (filter === 'Mentions' ? i.mention : i.unread > 0)));
  const active = $derived(items.find(i => i.id === selected) ?? items[0]);
  function send() { if (!draft.trim()) return; sent = [...sent,draft.trim()]; draft=''; }
</script>

<div class="priority-shell variant-enter">
  <aside class="priority-rail">
    <header><div><h1>Inbox</h1><p>{caughtUp ? 'You’re caught up' : '12 unread across 4 conversations'}</p></div><button aria-label="Compose message">✎</button></header>
    <div class="filters">{#each ['Unread','Mentions','All'] as option}<button class:active={filter === option} onclick={() => filter = option as Filter}>{option}{#if option === 'Unread'}<span>12</span>{:else if option === 'Mentions'}<span>2</span>{/if}</button>{/each}</div>
    <div class="catch-up"><span>Needs your attention</span><button onclick={() => caughtUp = true}>{caughtUp ? 'Caught up' : 'Mark all read'}</button></div>
    <div class="priority-list">
      {#each visible as item}
        <button class="priority-row" class:selected={selected === item.id} onclick={() => selected = item.id}>
          <span class="avatar">{item.initials}</span><span class="copy"><span class="line"><strong>{item.person}</strong><time>{item.time}</time></span><small>{item.kind} · {item.context}</small><p>{item.preview}</p></span>{#if item.unread && !caughtUp}<i></i>{/if}
        </button>
      {/each}
      {#if visible.length === 0}<div class="empty"><strong>Nothing waiting</strong><span>Switch to All to browse conversations.</span></div>{/if}
    </div>
  </aside>
  <main class="thread">
    <header class="thread-head"><div class="identity"><span class="avatar large">{active.initials}</span><div><h2>{active.person}</h2><p>{active.kind} · {active.context}</p></div></div><div class="actions"><button>Mark read</button><button aria-label="Search">⌕</button><button aria-label="Details">•••</button></div></header>
    <section class="context-strip"><span>Today</span><p><strong>Release coordination</strong> · Windows updater verification and public release checks</p><button>View summary</button></section>
    <div class="messages">
      <article><span class="avatar">JP</span><div><header><strong>Jacob Posel</strong><time>9:42 AM</time></header><p>The updater repair is merged. I’m checking the final release artifacts now.</p></div></article>
      <article class="mention"><span class="avatar">AS</span><div><header><strong>Alan Saura</strong><time>9:51 AM</time></header><p><mark>@Corey</mark> verified on a clean Windows install. The CLI resolves from the prefix and the installed version is confirmed before success.</p><div class="action-line"><span>Requested your review</span><button>Open release checks ↗</button></div></div></article>
      <article><span class="avatar">JP</span><div><header><strong>Jacob Posel</strong><time>10:01 AM</time></header><p>All four updater targets are present. Once the standing monitor passes, this thread can be closed.</p><div class="reactions"><button>✅ 2</button><button>👀 1</button></div></div></article>
      {#each sent as message}<article class="mine new-message"><span class="avatar">CE</span><div><header><strong>You</strong><time>now</time></header><p>{message}</p></div></article>{/each}
    </div>
    <footer class="reply"><div class="reply-label"><span>Replying in {active.person}</span><small>Visible to {active.kind === 'Group DM' ? '3 people' : active.person}</small></div><textarea bind:value={draft} placeholder="Write a reply…" onkeydown={(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}}></textarea><div class="reply-actions"><span><button>＋</button><button>Aa</button><button>☺</button></span><button class="send" disabled={!draft.trim()} onclick={send}>Send</button></div></footer>
  </main>
</div>

<style>
  .priority-shell { height:100%; display:grid; grid-template-columns:360px minmax(0,1fr); background:rgba(12,12,12,.26); }
  button{border:0;background:transparent;cursor:pointer} h1,h2,p{margin:0}
  .priority-rail{min-height:0;display:grid;grid-template-rows:auto auto auto 1fr;border-right:1px solid var(--v4-hairline);background:rgba(29,29,29,.5);backdrop-filter:var(--v4-glass-filter)}
  .priority-rail>header{display:flex;align-items:center;justify-content:space-between;padding:22px 22px 14px}.priority-rail h1{font-size:22px;letter-spacing:-.03em}.priority-rail header p{margin-top:3px;color:var(--v4-text-3);font-size:12px}.priority-rail header button{width:34px;height:34px;border-radius:var(--v4-radius-button);background:var(--v4-control-bg);font-size:17px}
  .filters{display:flex;gap:4px;padding:0 18px 16px;border-bottom:1px solid var(--v4-rowline)}.filters button{height:30px;padding:0 10px;border-radius:var(--v4-radius-button);color:var(--v4-text-3);font-size:12px}.filters button.active{background:var(--v4-control-bg);color:var(--v4-text-1)}.filters span{margin-left:5px;color:inherit}
  .catch-up{display:flex;align-items:center;height:42px;padding:0 22px;color:var(--v4-text-3);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}.catch-up button{margin-left:auto;color:var(--v4-text-2);font-size:11px;text-transform:none}
  .priority-list{min-height:0;overflow-y:auto}.priority-row{position:relative;display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;width:100%;padding:13px 22px;border-top:1px solid var(--v4-rowline);color:var(--v4-text-2);text-align:left}.priority-row:hover{background:rgba(255,255,255,.045)}.priority-row.selected{background:rgba(255,255,255,.1);box-shadow:inset 2px 0 var(--v4-text-1)}.priority-row>i{position:absolute;right:15px;top:18px;width:6px;height:6px;border-radius:50%;background:var(--v4-text-1)}
  .avatar{display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--v4-control-border);border-radius:50%;background:rgba(255,255,255,.07);font-size:10px;font-weight:650}.avatar.large{width:38px;height:38px}
  .copy{min-width:0}.copy .line{display:flex;align-items:baseline;gap:8px}.copy strong{overflow:hidden;color:var(--v4-text-1);font-size:13px;text-overflow:ellipsis;white-space:nowrap}.copy time{margin-left:auto;color:var(--v4-text-3);font-size:10px}.copy small{display:block;margin-top:2px;color:var(--v4-text-3);font-size:10px}.copy p{overflow:hidden;margin-top:6px;color:var(--v4-text-2);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.empty{display:grid;gap:5px;padding:36px 22px;color:var(--v4-text-3);font-size:12px}.empty strong{color:var(--v4-text-2)}
  .thread{min-width:0;min-height:0;display:grid;grid-template-rows:auto auto 1fr auto;background:rgba(14,14,14,.22)}.thread-head{display:flex;align-items:center;min-height:72px;padding:12px 28px;border-bottom:1px solid var(--v4-hairline);background:rgba(18,18,18,.36);backdrop-filter:var(--v4-glass-filter-soft)}.identity{display:flex;align-items:center;gap:11px}.identity h2{font-size:15px}.identity p{margin-top:3px;color:var(--v4-text-3);font-size:11px}.actions{margin-left:auto;display:flex;gap:5px}.actions button{height:30px;padding:0 10px;border-radius:var(--v4-radius-button);color:var(--v4-text-2)}.actions button:hover{background:var(--v4-control-bg)}
  .context-strip{display:flex;align-items:center;min-height:44px;padding:8px 28px;border-bottom:1px solid var(--v4-rowline);background:rgba(255,255,255,.025);color:var(--v4-text-3);font-size:11px}.context-strip>span{margin-right:14px;font-family:'Geist Mono',monospace;text-transform:uppercase}.context-strip p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.context-strip p strong{color:var(--v4-text-2)}.context-strip button{margin-left:auto;color:var(--v4-text-2);white-space:nowrap}
  .messages{min-height:0;overflow-y:auto;padding:28px clamp(32px,7vw,96px)}article{display:grid;grid-template-columns:34px minmax(0,740px);gap:12px;margin-bottom:24px}article header{display:flex;align-items:baseline;gap:8px}article header strong{font-size:13px}article time{color:var(--v4-text-3);font-size:10px}article p{margin-top:5px;color:var(--v4-text-2);font-size:14px;line-height:1.55}mark{padding:1px 4px;border-radius:3px;background:rgba(255,255,255,.12);color:var(--v4-text-1)}article.mention{padding:13px 14px;margin-left:-14px;border-left:2px solid var(--v4-text-2);background:rgba(255,255,255,.035)}
  .action-line{display:flex;align-items:center;max-width:600px;margin-top:12px;padding-top:10px;border-top:1px solid var(--v4-rowline);color:var(--v4-text-3);font-size:11px}.action-line button{margin-left:auto;color:var(--v4-text-1)}.reactions{display:flex;gap:5px;margin-top:8px}.reactions button{height:24px;padding:0 7px;border:1px solid var(--v4-control-border);border-radius:var(--v4-radius-pill);color:var(--v4-text-2);font-size:10px}
  .reply{margin:0 clamp(28px,7vw,90px) 18px;border:1px solid var(--v4-control-border);border-radius:var(--v4-radius-card);background:rgba(35,35,35,.6);backdrop-filter:var(--v4-glass-filter-soft);box-shadow:0 12px 30px rgba(0,0,0,.2)}.reply-label{display:flex;align-items:center;padding:9px 12px 7px;border-bottom:1px solid var(--v4-rowline);color:var(--v4-text-2);font-size:10px}.reply-label small{margin-left:auto;color:var(--v4-text-3)}textarea{display:block;width:100%;min-height:52px;resize:none;padding:12px;border:0;outline:0;background:transparent;color:var(--v4-text-1)}.reply-actions{display:flex;align-items:center;height:38px;padding:0 8px}.reply-actions span{display:flex}.reply-actions button{height:28px;min-width:28px;border-radius:var(--v4-radius-button);color:var(--v4-text-3)}.reply-actions .send{margin-left:auto;padding:0 13px;background:var(--v4-text-1);color:#111;font-weight:600}.send:disabled{opacity:.35}
  .variant-enter{animation:variant-in 220ms var(--ease-out) both}.new-message{animation:message-in 220ms var(--ease-out) both}@keyframes variant-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}@keyframes message-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.variant-enter,.new-message{animation:none}}@media(max-width:1180px){.priority-shell{grid-template-columns:320px minmax(0,1fr)}.messages{padding-inline:34px}.reply{margin-inline:34px}}
</style>
