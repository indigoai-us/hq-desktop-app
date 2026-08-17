<script lang="ts">
  type Room = { id: string; label: string; meta: string; initials: string; unread?: number; kind: 'dm'|'group'|'channel'; online?: boolean };
  const rooms: Room[] = [
    { id: 'jacob-alan', label: 'Jacob Posel, Alan Saura', meta: '3 people', initials: '3', unread: 1, kind: 'group' },
    { id: 'yousuf', label: 'Yousuf Kalim', meta: 'Direct message', initials: 'YK', online: true, kind: 'dm' },
    { id: 'lisa', label: 'Lisa', meta: 'Agent · active', initials: 'AI', online: true, kind: 'dm' },
    { id: 'hq-core', label: 'hq-core', meta: 'Channel', initials: '#', unread: 6, kind: 'channel' },
    { id: 'hq-agents', label: 'hq-agents', meta: 'Channel', initials: '#', kind: 'channel' },
    { id: 'hq-wins', label: 'hq-wins', meta: 'Channel', initials: '#', kind: 'channel' },
  ];
  let selected = $state('jacob-alan');
  let draft = $state('');
  let sent = $state<string[]>([]);
  const active = $derived(rooms.find((room) => room.id === selected) ?? rooms[0]);

  function send() { const value = draft.trim(); if (!value) return; sent = [...sent, value]; draft = ''; }
</script>

<div class="rooms-shell variant-enter">
  <aside class="room-rail">
    <div class="rail-head"><div><h1>Messages</h1><span>12 unread</span></div><button aria-label="New message">＋</button></div>
    <label class="search"><span>⌕</span><input aria-label="Search messages" placeholder="Search messages" /></label>
    <div class="rail-shortcuts"><button class="active">Threads <span>3</span></button><button>Mentions <span>2</span></button><button>Saved</button></div>
    <section>
      <header><span>Direct messages</span><button>＋</button></header>
      {#each rooms.filter((room) => room.kind !== 'channel') as room}
        <button class="room" class:selected={selected === room.id} class:unread={room.unread} onclick={() => selected = room.id}>
          <span class="avatar">{room.initials}{#if room.online}<i></i>{/if}</span><span class="room-copy"><strong>{room.label}</strong><small>{room.meta}</small></span>{#if room.unread}<b>{room.unread}</b>{/if}
        </button>
      {/each}
    </section>
    <section>
      <header><span>Channels</span><button>＋</button></header>
      {#each rooms.filter((room) => room.kind === 'channel') as room}
        <button class="room channel" class:selected={selected === room.id} class:unread={room.unread} onclick={() => selected = room.id}>
          <span class="avatar">#</span><span class="room-copy"><strong>{room.label}</strong></span>{#if room.unread}<b>{room.unread}</b>{/if}
        </button>
      {/each}
    </section>
  </aside>

  <main class="conversation">
    <header class="conversation-head"><div><h2>{active.kind === 'channel' ? '#' : ''}{active.label}</h2><p>{active.kind === 'group' ? 'Jacob Posel, Alan Saura, and you' : active.meta}</p></div><div class="head-actions"><button aria-label="Search conversation">⌕</button><button aria-label="Conversation details">ⓘ</button></div></header>
    <div class="timeline">
      <div class="day"><span>Today</span></div>
      <article class="message-group"><span class="large-avatar">JP</span><div><header><strong>Jacob Posel</strong><time>9:42 AM</time></header><p>The Windows updater repair is merged. I’m checking the final release artifacts now.</p><p>Can you verify the Core version resolves after the CLI shim is replaced?</p><div class="reactions"><button>✅ <span>2</span></button><button>＋</button></div></div></article>
      <article class="message-group"><span class="large-avatar">AS</span><div><header><strong>Alan Saura</strong><time>9:51 AM</time></header><p>Verified on a clean Windows install. The app now finds the npm prefix directly and confirms the installed version before completing.</p><aside class="file-share"><span>⌘</span><div><strong>windows-update-smoke.md</strong><small>Shared from Indigo · Engineering</small></div><button>Open</button></aside></div></article>
      <article class="message-group mine"><span class="large-avatar">CE</span><div><header><strong>You</strong><time>10:03 AM</time></header><p>Perfect. I’ll keep the release monitor open and post here when stable latest advances.</p></div></article>
      {#each sent as message}<article class="message-group mine new-message"><span class="large-avatar">CE</span><div><header><strong>You</strong><time>now</time></header><p>{message}</p></div></article>{/each}
    </div>
    <footer class="composer"><textarea bind:value={draft} onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder={`Message ${active.label}`}></textarea><div><span><button aria-label="Add attachment">＋</button><button aria-label="Add emoji">☺</button><button aria-label="Format message">Aa</button></span><small>⌘↵ to send</small><button class="send" onclick={send} disabled={!draft.trim()}>Send</button></div></footer>
  </main>
</div>

<style>
  .rooms-shell { height: 100%; display: grid; grid-template-columns: 304px minmax(0,1fr); background: rgba(12,12,12,.26); }
  .room-rail { min-height: 0; overflow-y: auto; padding: 20px 12px; border-right: 1px solid var(--v4-hairline); background: rgba(32,32,32,.46); backdrop-filter: var(--v4-glass-filter); }
  .rail-head { display: flex; align-items: center; justify-content: space-between; padding: 0 8px 15px; }
  h1,h2,p { margin: 0; } h1 { font-size: 21px; letter-spacing: -.02em; } .rail-head span { color: var(--v4-text-3); font-size: 12px; }
  button { border: 0; background: transparent; cursor: pointer; }
  .rail-head button { width: 32px; height: 32px; border-radius: var(--v4-radius-button); background: var(--v4-control-bg); font-size: 18px; }
  .search { display: flex; align-items: center; height: 34px; margin: 0 6px 12px; padding: 0 10px; border: 1px solid var(--v4-control-border); border-radius: var(--v4-radius-field); background: rgba(0,0,0,.18); color: var(--v4-text-3); }
  .search input { width: 100%; border: 0; outline: 0; background: transparent; color: inherit; }
  .rail-shortcuts { display: grid; gap: 2px; margin-bottom: 18px; }
  .rail-shortcuts button { display: flex; align-items: center; height: 31px; padding: 0 10px; border-radius: var(--v4-radius-button); color: var(--v4-text-2); text-align: left; }
  .rail-shortcuts button.active,.rail-shortcuts button:hover { background: rgba(255,255,255,.07); color: var(--v4-text-1); }
  .rail-shortcuts span { margin-left: auto; color: var(--v4-text-3); font-size: 12px; }
  section { margin-top: 12px; } section > header { display: flex; align-items: center; height: 28px; padding: 0 9px; color: var(--v4-text-3); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; } section > header button { margin-left: auto; color: inherit; font-size: 16px; }
  .room { position: relative; display: grid; grid-template-columns: 32px minmax(0,1fr) auto; align-items: center; width: 100%; min-height: 44px; gap: 9px; padding: 5px 9px; border-radius: var(--v4-radius-button); color: var(--v4-text-2); text-align: left; }
  .room:hover { background: rgba(255,255,255,.05); } .room.selected { background: rgba(255,255,255,.11); color: var(--v4-text-1); } .room.unread strong { color: var(--v4-text-1); font-weight: 650; }
  .avatar { position: relative; display: grid; place-items: center; width: 31px; height: 31px; border: 1px solid var(--v4-control-border); border-radius: 50%; background: rgba(255,255,255,.07); font-size: 11px; font-weight: 600; }
  .avatar i { position: absolute; right: -1px; bottom: 0; width: 8px; height: 8px; border: 2px solid #252525; border-radius: 50%; background: var(--v4-ok); }
  .channel .avatar { border: 0; background: transparent; color: var(--v4-text-3); font-size: 19px; }
  .room-copy { min-width: 0; display: grid; gap: 1px; } .room-copy strong,.room-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .room-copy strong { font-size: 13px; font-weight: 500; } .room-copy small { color: var(--v4-text-3); font-size: 11px; }
  .room b { min-width: 19px; padding: 2px 5px; border-radius: var(--v4-radius-pill); background: var(--v4-text-1); color: #111; font-size: 10px; text-align: center; }
  .conversation { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto 1fr auto; background: rgba(15,15,15,.2); }
  .conversation-head { display: flex; align-items: center; min-height: 70px; padding: 13px 26px; border-bottom: 1px solid var(--v4-hairline); background: rgba(20,20,20,.32); backdrop-filter: var(--v4-glass-filter-soft); }
  .conversation-head h2 { font-size: 16px; } .conversation-head p { margin-top: 3px; color: var(--v4-text-3); font-size: 12px; }
  .head-actions { margin-left: auto; display: flex; gap: 5px; } .head-actions button { width: 32px; height: 32px; border-radius: var(--v4-radius-button); color: var(--v4-text-2); } .head-actions button:hover { background: var(--v4-control-bg); }
  .timeline { min-height: 0; overflow-y: auto; padding: 16px 7% 28px; }
  .day { display: flex; align-items: center; gap: 14px; margin: 4px 0 24px; color: var(--v4-text-3); font-size: 11px; } .day::before,.day::after { content:''; height: 1px; flex: 1; background: var(--v4-rowline); }
  .message-group { display: grid; grid-template-columns: 38px minmax(0,720px); gap: 12px; margin: 0 0 22px; } .large-avatar { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--v4-control-border); border-radius: 50%; background: rgba(255,255,255,.08); font-size: 11px; font-weight: 600; }
  .message-group header { display: flex; align-items: baseline; gap: 8px; } .message-group header strong { font-size: 13px; } time { color: var(--v4-text-3); font-size: 10px; }
  .message-group p { margin-top: 5px; color: var(--v4-text-2); font-size: 14px; line-height: 1.55; } .message-group p + p { margin-top: 2px; }
  .reactions { display: flex; gap: 5px; margin-top: 8px; } .reactions button { height: 25px; padding: 0 7px; border: 1px solid var(--v4-control-border); border-radius: var(--v4-radius-pill); color: var(--v4-text-2); font-size: 11px; }
  .file-share { display: flex; align-items: center; gap: 10px; max-width: 510px; margin-top: 12px; padding: 11px 0; border-block: 1px solid var(--v4-rowline); } .file-share > span { font-size: 20px; } .file-share div { display: grid; } .file-share small { color: var(--v4-text-3); } .file-share button { margin-left: auto; height: 28px; padding: 0 10px; border: 1px solid var(--v4-control-border); border-radius: var(--v4-radius-button); background: var(--v4-control-bg); }
  .new-message { animation: message-in 220ms var(--ease-out) both; }
  .composer { margin: 0 7% 18px; border: 1px solid var(--v4-control-border); border-radius: var(--v4-radius-card); background: rgba(35,35,35,.62); backdrop-filter: var(--v4-glass-filter-soft); box-shadow: 0 12px 28px rgba(0,0,0,.18); }
  textarea { display: block; width: 100%; min-height: 58px; resize: none; padding: 13px 14px 4px; border: 0; outline: 0; background: transparent; color: var(--v4-text-1); }
  .composer > div { display: flex; align-items: center; height: 38px; padding: 0 8px; } .composer span { display: flex; } .composer button { height: 28px; min-width: 28px; border-radius: var(--v4-radius-button); color: var(--v4-text-3); } .composer small { margin-left: auto; color: var(--v4-text-3); font-family: 'Geist Mono',monospace; font-size: 10px; }
  .composer .send { margin-left: 10px; padding: 0 12px; background: var(--v4-text-1); color: #111; font-weight: 600; } .composer .send:disabled { opacity: .35; }
  .variant-enter { animation: variant-in 220ms var(--ease-out) both; transform-origin: center top; }
  @keyframes variant-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } } @keyframes message-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .variant-enter,.new-message { animation: none; } }
  @media (max-width: 1180px) { .rooms-shell { grid-template-columns: 264px minmax(0,1fr); } .timeline,.composer { margin-inline: 4%; } .timeline { padding-inline: 4%; } }
</style>
