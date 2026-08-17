<script lang="ts">
  type Room = { id:string; label:string; kind:'dm'|'group'|'channel'; initials?:string; unread?:number; private?:boolean; online?:boolean };
  const rooms: Room[] = [
    { id:'yousuf', label:'Yousuf Kalim', kind:'dm', initials:'YK', online:true },
    { id:'group', label:'Jacob Posel, Alan Saura', kind:'group', initials:'3', unread:1 },
    { id:'corey-exec', label:'corey-exec', kind:'channel', private:true },
    { id:'agents', label:'hq-agents', kind:'channel', unread:4 },
    { id:'core', label:'hq-core', kind:'channel' },
    { id:'dev', label:'hq-dev', kind:'channel', private:true },
    { id:'engineering', label:'hq-engineering-talks', kind:'channel' },
    { id:'gtm', label:'hq-gtm', kind:'channel' },
    { id:'team', label:'hq-team', kind:'channel' },
  ];
  let activeId = $state('group');
  let draft = $state('');
  let sent = $state<string[]>([]);
  let query = $state('');
  const active = $derived(rooms.find(room => room.id === activeId) ?? rooms[0]);
  const filtered = $derived(rooms.filter(room => room.label.toLowerCase().includes(query.toLowerCase())));
  function send(){ const value=draft.trim(); if(!value)return; sent=[...sent,value]; draft=''; }
</script>

<div class="compact-shell variant-enter">
  <aside class="room-rail">
    <header><strong>HQ</strong><span>12 unread</span><button aria-label="New message">✎</button></header>
    <label class="search"><span>⌕</span><input bind:value={query} placeholder="Find a conversation" aria-label="Find a conversation" /></label>
    <nav class="utility"><button>☵ <span>Threads</span></button><button>＠ <span>Mentions</span><b>3</b></button></nav>
    <section>
      <h2>Direct messages <button aria-label="Add direct message">＋</button></h2>
      {#each filtered.filter(room => room.kind !== 'channel') as room}
        <button class="room" class:active={room.id === activeId} onclick={() => activeId=room.id}>
          <i class:group={room.kind==='group'}>{room.kind === 'group' ? '♙' : room.initials}</i>
          <span>{room.label}</span>{#if room.online}<em></em>{/if}{#if room.unread}<b>{room.unread}</b>{/if}
        </button>
      {/each}
    </section>
    <section class="channels">
      <h2>Channels <button aria-label="Add channel">＋</button></h2>
      {#each filtered.filter(room => room.kind === 'channel') as room}
        <button class="room" class:active={room.id === activeId} onclick={() => activeId=room.id}>
          <i class="glyph">{room.private ? '⌑' : '#'}</i><span>{room.label}</span>{#if room.unread}<b>{room.unread}</b>{/if}
        </button>
      {/each}
    </section>
    <footer><button>Open full desktop view ↗</button></footer>
  </aside>
  <main class="conversation">
    <header class="conversation-head"><div><strong>{active.kind==='channel' ? `${active.private ? '⌑' : '#'} ${active.label}` : active.label}</strong><small>{active.kind==='group' ? '3 members' : active.kind==='channel' ? 'Indigo · Messages' : 'Direct message'}</small></div><span><button aria-label="Search conversation">⌕</button><button aria-label="Conversation details">•••</button></span></header>
    <div class="timeline">
      <div class="day"><span></span><time>Today</time><span></span></div>
      <article><i>JP</i><div><header><strong>Jacob Posel</strong><time>9:42 AM</time></header><p>The Windows updater repair is merged. I’m checking the final release artifacts now.</p></div></article>
      <article><i>AS</i><div><header><strong>Alan Saura</strong><time>9:51 AM</time></header><p>Verified on a clean install. Core now resolves before the update is marked complete.</p><button class="thread">2 replies · last reply 4m ago</button></div></article>
      <article><i>CE</i><div><header><strong>You</strong><time>10:03 AM</time></header><p>Perfect. I’ll keep the release monitor open and post here when stable latest advances.</p></div></article>
      {#each sent as message}<article class="new-message"><i>CE</i><div><header><strong>You</strong><time>now</time></header><p>{message}</p></div></article>{/each}
    </div>
    <footer class="composer"><textarea bind:value={draft} placeholder={`Message ${active.label}`} onkeydown={(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}}}></textarea><div><span><button>＋</button><button>Aa</button><button>☺</button><button>＠</button></span><button class="send" onclick={send} disabled={!draft.trim()}>↑</button></div></footer>
  </main>
</div>

<style>
  button,input,textarea{border:0;outline:0;background:transparent;color:inherit}.compact-shell{display:grid;grid-template-columns:282px minmax(0,1fr);min-height:0;flex:1}.room-rail{display:flex;flex-direction:column;min-height:0;padding:14px 10px 10px;border-right:1px solid var(--v4-hairline);background:rgba(19,19,19,.42);backdrop-filter:blur(28px) saturate(118%)}.room-rail>header{display:flex;align-items:center;height:36px;padding:0 8px}.room-rail>header strong{font-size:16px}.room-rail>header span{margin-left:8px;color:var(--v4-text-3);font-size:11px}.room-rail>header button{margin-left:auto;width:30px;height:30px;border-radius:6px;font-size:16px}.room-rail>header button:hover,.utility button:hover,.room:hover{background:rgba(255,255,255,.055)}.search{display:flex;align-items:center;height:32px;margin:7px 4px 10px;padding:0 9px;border:1px solid var(--v4-control-border);border-radius:6px;background:rgba(255,255,255,.035)}.search span{color:var(--v4-text-3)}.search input{width:100%;padding-left:7px;font-size:12px}.utility{display:grid;gap:2px;padding-bottom:10px;border-bottom:1px solid var(--v4-rowline)}.utility button,.room{display:flex;align-items:center;width:100%;height:30px;padding:0 9px;border-radius:6px;text-align:left;cursor:pointer}.utility button span{margin-left:10px}.utility b,.room b{min-width:20px;margin-left:auto;padding:1px 5px;border-radius:99px;background:var(--v4-text-1);color:#111;font-size:10px;text-align:center}.room-rail section{margin-top:13px}.room-rail h2{display:flex;align-items:center;height:24px;margin:0;padding:0 9px;color:var(--v4-text-3);font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase}.room-rail h2 button{margin-left:auto;color:var(--v4-text-3);font-size:15px}.room i{display:grid;place-items:center;flex:0 0 22px;width:22px;height:22px;margin-right:8px;border:1px solid var(--v4-control-border);border-radius:6px;background:rgba(255,255,255,.055);font-size:9px;font-style:normal;font-weight:600}.room i.glyph{border:0;background:transparent;color:var(--v4-text-2);font-size:15px}.room i.group{border-radius:50%;font-size:13px}.room span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.room em{width:6px;height:6px;margin-left:auto;border-radius:50%;background:var(--v4-ok)}.room.active{background:rgba(255,255,255,.115);color:var(--v4-text-1);font-weight:600}.channels{min-height:0;overflow:auto}.room-rail>footer{margin-top:auto;padding:9px 4px 0;border-top:1px solid var(--v4-rowline)}.room-rail>footer button{width:100%;height:30px;color:var(--v4-text-2);font-size:11px;text-align:left}.conversation{display:flex;flex-direction:column;min-width:0;min-height:0;background:rgba(14,14,14,.22)}.conversation-head{display:flex;align-items:center;min-height:56px;padding:0 22px;border-bottom:1px solid var(--v4-hairline)}.conversation-head>div{display:grid;gap:3px}.conversation-head strong{font-size:14px}.conversation-head small{color:var(--v4-text-3);font-size:10px}.conversation-head>span{display:flex;margin-left:auto}.conversation-head button{width:30px;height:30px;border-radius:6px;color:var(--v4-text-2)}.conversation-head button:hover{background:rgba(255,255,255,.055)}.timeline{flex:1;min-height:0;overflow:auto;padding:20px 28px}.day{display:flex;align-items:center;gap:12px;margin-bottom:20px}.day span{height:1px;flex:1;background:var(--v4-rowline)}.day time{color:var(--v4-text-3);font-size:10px}.timeline article{display:grid;grid-template-columns:32px minmax(0,640px);gap:11px;margin-bottom:20px}.timeline article>i{display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--v4-control-border);border-radius:7px;background:rgba(255,255,255,.06);font-size:9px;font-style:normal;font-weight:600}.timeline article header{display:flex;align-items:baseline;gap:7px}.timeline article header strong{font-size:12px}.timeline article header time{color:var(--v4-text-3);font-size:9px}.timeline article p{margin:4px 0 0;color:var(--v4-text-2);font-size:13px;line-height:1.5}.thread{margin-top:7px;color:var(--v4-text-2);font-size:10px}.thread:hover{text-decoration:underline}.composer{margin:0 24px 18px;border:1px solid var(--v4-control-border);border-radius:7px;background:rgba(34,34,34,.58);backdrop-filter:var(--v4-glass-filter-soft)}.composer textarea{display:block;width:100%;min-height:54px;resize:none;padding:11px;color:var(--v4-text-1);font-size:12px}.composer>div{display:flex;align-items:center;height:34px;padding:0 6px}.composer span{display:flex}.composer button{width:27px;height:27px;border-radius:5px;color:var(--v4-text-3)}.composer .send{margin-left:auto;border-radius:50%;background:var(--v4-text-1);color:#111;font-size:16px}.composer .send:disabled{opacity:.28}.variant-enter{animation:variant-in 220ms var(--ease-out) both}.new-message{animation:message-in 220ms var(--ease-out) both}@keyframes variant-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}@keyframes message-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.variant-enter,.new-message{animation:none}}
  .utility button{font-size:12px;font-weight:500}.room i{border:0;border-radius:50%;background:rgba(255,255,255,.075)}
</style>
