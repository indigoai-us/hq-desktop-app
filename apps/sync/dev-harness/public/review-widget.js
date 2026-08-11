/**
 * Review widget — click-to-comment layer for the shared design preview.
 *
 * Ships only with the browser preview build (vite.preview.config.ts sets
 * publicDir to dev-harness/public). The Tauri app build never sees this file.
 *
 * Storage is deliberately local: hq-deploy serves the preview as static files
 * with no write API behind it, so notes live in the reviewer's own
 * localStorage until they hit Copy / Download and send them along. The UI says
 * so plainly rather than implying a synced thread.
 *
 * Anchoring: each note stores a CSS path to the element under the click plus
 * fractional offsets inside that element's box, so pins track the layout
 * through scrolls and resizes. Page coordinates are kept as a fallback for
 * when the element no longer exists in a later build.
 */
(function () {
  'use strict';

  if (window.__hqReviewWidget) return;
  window.__hqReviewWidget = true;

  var STORE_KEY = 'hq-review::' + location.pathname + location.search;
  var NAME_KEY = 'hq-review::author';
  var MAX_LABEL = 48;

  // ---------------------------------------------------------------- storage

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(notes));
    } catch (e) {
      /* quota or private mode — the session still works, it just won't persist */
    }
  }

  function author() {
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setAuthor(name) {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch (e) {
      /* ignore */
    }
  }

  var notes = load();
  var armed = false;
  var openId = null;

  // ------------------------------------------------------------- anchoring

  function cssPath(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      var parent = node.parentNode;
      if (!parent) break;
      var index = 1;
      var sib = node;
      while ((sib = sib.previousElementSibling)) index++;
      parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + index + ')');
      node = parent;
    }
    return parts.join('>') || 'body';
  }

  function resolve(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function labelFor(el) {
    if (!el) return '';
    // innerText, not textContent: it respects rendering, so block boundaries
    // become whitespace instead of running words together ("TODAYB Bryan").
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) text = el.getAttribute('aria-label') || el.tagName.toLowerCase();
    return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL) + '…' : text;
  }

  /**
   * Viewport-space position for a note, or null when its spot is not on the
   * current screen. The harness swaps whole views in place, so an nth-child
   * selector can happily resolve to an unrelated element on another screen —
   * require the element's text to still look like what was commented on
   * before trusting it. No coordinate fallback for anchored notes: a pin
   * floating over the wrong screen is worse than no pin.
   */
  function anchorMatches(note, el) {
    if (!note.label) return true; // nothing recorded to compare against
    var now = labelFor(el);
    if (!now) return false;
    // Whitespace-insensitive: labels saved by earlier builds used textContent
    // (block boundaries collapse differently than innerText renders them).
    var a = now.replace(/\s+/g, '').slice(0, 24);
    var b = note.label.replace(/\s+/g, '').slice(0, 24);
    return a === b;
  }

  /**
   * Snapshot of the app's visible navigation state — the labels of whatever
   * reads as "selected" right now (active tab, active channel row, open
   * panel). Stored with each note so the list can find its way back to the
   * screen the note was made on. Label-based on purpose: nth-child paths to
   * nav controls are exactly what goes stale between screens.
   */
  var NAV_ACTIVE = '[aria-selected="true"],[aria-current],.on,.active,.selected';
  var NAV_CLICKABLE = 'button,a,[role="tab"],[role="button"],[role="menuitem"],li';

  function navLabel(el) {
    var t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    // Anything long is a selected *container*, not a nav control — skip it.
    return t && t.length <= 40 ? t : '';
  }

  function navSignature() {
    var out = [];
    var addFrom = function (els, max) {
      for (var i = 0; i < els.length && out.length < max; i++) {
        var label = navLabel(els[i]);
        if (label && out.indexOf(label) === -1) out.push(label);
      }
    };
    addFrom(document.querySelectorAll(NAV_ACTIVE), 8);
    // Screen headings too: views opened from icon buttons (Meetings, Library)
    // mark nothing as "selected", so the heading is the only breadcrumb — the
    // way back is the control whose accessible label matches it.
    addFrom(document.querySelectorAll('h1,h2,h3,[class*="title"]'), 12);
    return out;
  }

  function isActiveLabel(label) {
    var els = document.querySelectorAll(NAV_ACTIVE);
    for (var i = 0; i < els.length; i++) {
      if (navLabel(els[i]) === label) return true;
    }
    return false;
  }

  /** Text label if any, else the accessible label — icon buttons have no text. */
  function clickLabel(el) {
    var t = navLabel(el);
    if (t) return t;
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('data-tip') ||
      el.getAttribute('title') ||
      ''
    ).trim();
  }

  function findClickable(label) {
    var els = document.querySelectorAll(NAV_CLICKABLE);
    for (var i = 0; i < els.length; i++) {
      if (clickLabel(els[i]) === label) return els[i];
    }
    return null;
  }

  /**
   * Re-open the screen a note was made on by re-clicking the nav controls
   * that were active back then, one per pass, until the note's anchor
   * resolves again (or we run out of things to click).
   */
  function navigateTo(note, done) {
    var passes = 0;
    function attempt() {
      if (positionOf(note)) return done(true);
      if (++passes > 5) return done(false);
      var nav = note.nav || [];
      for (var i = 0; i < nav.length; i++) {
        if (isActiveLabel(nav[i])) continue;
        var el = findClickable(nav[i]);
        if (el) {
          el.click();
          setTimeout(attempt, 200);
          return;
        }
      }
      done(false);
    }
    attempt();
  }

  function positionOf(note) {
    var el = resolve(note.selector);
    if (el && anchorMatches(note, el)) {
      var rect = el.getBoundingClientRect();
      if (rect.width || rect.height) {
        return { x: rect.left + note.fx * rect.width, y: rect.top + note.fy * rect.height };
      }
    }
    if (!note.selector) {
      return { x: note.px - window.scrollX, y: note.py - window.scrollY };
    }
    return null;
  }

  // ----------------------------------------------------------------- shell

  var host = document.createElement('div');
  host.id = 'hq-review-root';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  var root = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  var style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.layer{position:fixed;inset:0;pointer-events:none}',
    '.catcher{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;background:rgba(10,12,16,.06)}',
    '.pin{position:fixed;pointer-events:auto;padding:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50% 50% 50% 2px;',
    'background:#f5a524;color:#1a1205;border:1.5px solid rgba(0,0,0,.28);box-shadow:0 2px 8px rgba(0,0,0,.35);',
    'font-size:12px;font-weight:650;line-height:23px;text-align:center;cursor:pointer;transition:transform .1s ease}',
    '.pin:hover{transform:scale(1.12)}',
    '.pin.open{background:#ffd27d}',
    '.card{position:fixed;pointer-events:auto;width:288px;background:#ffffff;color:#14161a;border:1px solid rgba(0,0,0,.14);',
    'border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.28);padding:12px;font-size:13px}',
    '.card h4{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.55}',
    '.card .meta{margin:0 0 8px;font-size:11px;opacity:.6;line-height:1.45}',
    '.card .body{margin:0 0 10px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}',
    'textarea{width:100%;min-height:76px;resize:vertical;padding:8px;font-size:13px;line-height:1.45;',
    'border:1px solid rgba(0,0,0,.18);border-radius:8px;background:#fbfbfc;color:inherit}',
    'input[type=text]{width:100%;padding:7px 8px;font-size:13px;border:1px solid rgba(0,0,0,.18);',
    'border-radius:8px;background:#fbfbfc;color:inherit;margin-bottom:8px}',
    'textarea:focus,input:focus{outline:2px solid #f5a524;outline-offset:-1px}',
    '.row{display:flex;gap:6px;align-items:center;margin-top:8px}',
    '.row.end{justify-content:flex-end}',
    'button{font:inherit;font-size:12px;font-weight:550;padding:6px 11px;border-radius:8px;cursor:pointer;',
    'border:1px solid rgba(0,0,0,.16);background:#f3f4f6;color:#14161a}',
    'button:hover{background:#e8eaee}',
    'button.primary{background:#111113;border-color:#111113;color:#fff}',
    'button.primary:hover{background:#2c2c31}',
    'button.ghost{background:transparent;border-color:transparent;opacity:.65}',
    'button.ghost:hover{background:rgba(0,0,0,.06);opacity:1}',
    // 13px = the buttons' 8px radius + the bar's 5px padding, so the outer
    // corner runs concentric with the inner ones instead of reading as a pill.
    '.bar{position:fixed;right:16px;bottom:16px;pointer-events:auto;display:flex;gap:6px;align-items:center;',
    'background:rgba(22,24,29,.94);border:1px solid rgba(255,255,255,.14);border-radius:13px;padding:5px 6px 5px 12px;',
    'box-shadow:0 8px 26px rgba(0,0,0,.34)}',
    '.bar .lbl{font-size:12px;font-weight:550;color:#f2f3f5;margin-right:2px}',
    '.bar button{background:rgba(255,255,255,.1);border-color:transparent;color:#f2f3f5}',
    '.bar button:hover{background:rgba(255,255,255,.2)}',
    '.bar button.primary{background:#111113;color:#fff;border:1px solid rgba(255,255,255,.35)}',
    '.panel{position:fixed;right:16px;bottom:64px;pointer-events:auto;width:330px;max-height:min(66vh,560px);',
    'display:flex;flex-direction:column;background:#ffffff;color:#14161a;border:1px solid rgba(0,0,0,.14);',
    'border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.3);overflow:hidden}',
    '.panel header{padding:11px 13px;border-bottom:1px solid rgba(0,0,0,.09);display:flex;align-items:center;gap:8px}',
    '.panel header strong{font-size:13px;font-weight:600;flex:1}',
    '.panel .list{overflow:auto;padding:5px 0}',
    '.panel .item{padding:9px 13px;border-bottom:1px solid rgba(0,0,0,.05);cursor:pointer;font-size:12.5px;line-height:1.5}',
    '.panel .item:hover{background:rgba(245,165,36,.1)}',
    '.panel .item .n{font-weight:650;margin-right:5px}',
    '.panel .item .where{display:block;font-size:11px;opacity:.55;margin-top:2px}',
    '.panel .empty{padding:22px 14px;text-align:center;font-size:12.5px;opacity:.6;line-height:1.55}',
    '.panel footer{padding:9px 11px;border-top:1px solid rgba(0,0,0,.09);display:flex;gap:6px;align-items:center}',
    '.note{padding:8px 13px 10px;font-size:11px;line-height:1.5;opacity:.62;border-top:1px solid rgba(0,0,0,.06)}',
    '@media (prefers-color-scheme:dark){',
    '.card,.panel{background:#1b1e24;color:#eef0f3;border-color:rgba(255,255,255,.14)}',
    'button.primary{border-color:rgba(255,255,255,.3)}',
    'textarea,input[type=text]{background:#12141a;border-color:rgba(255,255,255,.16)}',
    'button{background:rgba(255,255,255,.1);border-color:transparent;color:#eef0f3}',
    'button:hover{background:rgba(255,255,255,.18)}',
    '.panel header,.panel footer{border-color:rgba(255,255,255,.1)}',
    '.panel .item{border-color:rgba(255,255,255,.06)}',
    '.panel .item:hover{background:rgba(245,165,36,.16)}',
    '.note{border-color:rgba(255,255,255,.08)}',
    '.catcher{background:rgba(255,255,255,.05)}}',
  ].join('\n');
  root.appendChild(style);

  var layer = document.createElement('div');
  layer.className = 'layer';
  root.appendChild(layer);

  // ------------------------------------------------------------- rendering

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Live pins, so scroll/resize can move them without rebuilding the DOM. */
  var pinEls = [];

  function render() {
    debug.renders++;
    layer.textContent = '';
    pinEls = [];

    if (armed) {
      var catcher = el('div', 'catcher');
      catcher.addEventListener('click', onPlace, true);
      layer.appendChild(catcher);
    }

    notes.forEach(function (note, i) {
      var pos = positionOf(note);
      if (!pos) return; // its spot is on a different screen right now
      if (pos.x < -40 || pos.y < -40 || pos.x > innerWidth + 40 || pos.y > innerHeight + 40) return;
      var pin = el('button', 'pin' + (openId === note.id ? ' open' : ''), String(i + 1));
      pin.style.left = pos.x + 'px';
      pin.style.top = pos.y + 'px';
      pinEls.push({ note: note, el: pin });
      pin.title = note.body;
      pin.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openId = openId === note.id ? null : note.id;
        draft = null;
        render();
      });
      layer.appendChild(pin);
      if (openId === note.id) layer.appendChild(noteCard(note, pos));
    });

    if (draft) layer.appendChild(composer(draft));
    layer.appendChild(bar());
    if (panelOpen) layer.appendChild(panel());
  }

  function placeCard(card, pos) {
    // Append first so offsetHeight is real, then nudge inside the viewport.
    card.style.left = clamp(pos.x + 18, 8, innerWidth - 296) + 'px';
    card.style.top = '0px';
    requestAnimationFrame(function () {
      var h = card.offsetHeight || 160;
      card.style.top = clamp(pos.y - 10, 8, innerHeight - h - 8) + 'px';
    });
  }

  function noteCard(note, pos) {
    var card = el('div', 'card');
    card.appendChild(el('h4', null, 'Note ' + (notes.indexOf(note) + 1)));
    card.appendChild(el('p', 'body', note.body));
    var meta = el('p', 'meta', (note.author || 'Anonymous') + ' · ' + when(note.createdAt));
    if (note.label) meta.textContent += ' · near “' + note.label + '”';
    card.appendChild(meta);

    var row = el('div', 'row end');
    var edit = el('button', null, 'Edit');
    edit.addEventListener('click', function () {
      draft = { id: note.id, body: note.body, pos: pos, label: note.label };
      openId = null;
      render();
    });
    var del = el('button', 'ghost', 'Delete');
    del.addEventListener('click', function () {
      notes = notes.filter(function (n) {
        return n.id !== note.id;
      });
      openId = null;
      save();
      render();
    });
    var close = el('button', null, 'Close');
    close.addEventListener('click', function () {
      openId = null;
      render();
    });
    row.appendChild(del);
    row.appendChild(edit);
    row.appendChild(close);
    card.appendChild(row);
    placeCard(card, pos);
    return card;
  }

  var draft = null;

  function composer(d) {
    var card = el('div', 'card');
    card.appendChild(el('h4', null, d.id ? 'Edit note' : 'New note'));
    if (d.label) card.appendChild(el('p', 'meta', 'near “' + d.label + '”'));

    var nameInput = null;
    if (!author()) {
      nameInput = el('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Your name';
      card.appendChild(nameInput);
    }

    var area = el('textarea');
    area.placeholder = 'What should change here?';
    area.value = d.body || '';
    // Keep the draft on the model so a rebuild can never eat what was typed.
    area.addEventListener('input', function () {
      d.body = area.value;
    });
    card.appendChild(area);

    var row = el('div', 'row end');
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.addEventListener('click', function () {
      draft = null;
      render();
    });
    var saveBtn = el('button', 'primary', 'Save');

    function commit() {
      var body = area.value.trim();
      if (!body) {
        area.focus();
        return;
      }
      if (nameInput && nameInput.value.trim()) setAuthor(nameInput.value.trim());
      if (d.id) {
        notes.forEach(function (n) {
          if (n.id === d.id) n.body = body;
        });
      } else {
        notes.push({
          id: 'n' + notes.length + '-' + performance.now().toString(36).replace('.', ''),
          body: body,
          author: author(),
          createdAt: new Date().toISOString(),
          selector: d.selector,
          label: d.label,
          nav: d.nav,
          fx: d.fx,
          fy: d.fy,
          px: d.px,
          py: d.py,
        });
      }
      draft = null;
      save();
      render();
    }

    saveBtn.addEventListener('click', commit);
    area.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) commit();
      if (ev.key === 'Escape') {
        draft = null;
        render();
      }
    });
    row.appendChild(cancel);
    row.appendChild(saveBtn);
    card.appendChild(row);
    placeCard(card, d.pos);
    requestAnimationFrame(function () {
      (nameInput || area).focus();
    });
    return card;
  }

  var panelOpen = false;

  function bar() {
    var wrap = el('div', 'bar');
    wrap.appendChild(el('span', 'lbl', 'Comments'));

    var toggle = el('button', armed ? 'primary' : '', armed ? 'Click a spot' : 'Add');
    toggle.addEventListener('click', function () {
      armed = !armed;
      draft = null;
      openId = null;
      render();
    });
    wrap.appendChild(toggle);

    var list = el('button', null, notes.length ? 'List (' + notes.length + ')' : 'List');
    list.addEventListener('click', function () {
      panelOpen = !panelOpen;
      render();
    });
    wrap.appendChild(list);
    return wrap;
  }

  function panel() {
    var wrap = el('div', 'panel');

    var head = document.createElement('header');
    head.appendChild(el('strong', null, notes.length + (notes.length === 1 ? ' note' : ' notes')));
    var hide = el('button', 'ghost', 'Hide');
    hide.addEventListener('click', function () {
      panelOpen = false;
      render();
    });
    head.appendChild(hide);
    wrap.appendChild(head);

    var list = el('div', 'list');
    if (!notes.length) {
      list.appendChild(
        el('div', 'empty', 'No notes yet. Hit Add, then click anywhere on the page to leave one.'),
      );
    }
    notes.forEach(function (note, i) {
      var item = el('div', 'item');
      var n = el('span', 'n', i + 1 + '.');
      item.appendChild(n);
      item.appendChild(document.createTextNode(note.body));
      var visible = !!positionOf(note);
      var canJump = !visible && note.nav && note.nav.length;
      var where = (note.author || 'Anonymous') + (note.label ? ' · near “' + note.label + '”' : '');
      if (!visible) where += canJump ? ' · on another screen — click to jump' : ' · not on this screen';
      item.appendChild(el('span', 'where', where));
      function focusNote() {
        var el2 = resolve(note.selector);
        if (el2 && el2.scrollIntoView) el2.scrollIntoView({ block: 'center', behavior: 'smooth' });
        openId = note.id;
        render();
      }
      item.addEventListener('click', function () {
        if (visible) return focusNote();
        if (!canJump) return; // old note with no recorded screen — nowhere to jump
        navigateTo(note, function (found) {
          if (found) focusNote();
        });
      });
      list.appendChild(item);
    });
    wrap.appendChild(list);

    var foot = document.createElement('footer');
    var copy = el('button', 'primary', 'Copy all');
    copy.addEventListener('click', function () {
      exportText(function (text) {
        copyText(text, copy);
      });
    });
    var dl = el('button', null, 'Download');
    dl.addEventListener('click', function () {
      exportText(download);
    });
    var clear = el('button', 'ghost', 'Clear');
    clear.addEventListener('click', function () {
      if (!notes.length) return;
      if (!confirm('Delete all ' + notes.length + ' notes on this page?')) return;
      notes = [];
      openId = null;
      save();
      render();
    });
    foot.appendChild(copy);
    foot.appendChild(dl);
    foot.appendChild(clear);
    wrap.appendChild(foot);

    wrap.appendChild(
      el(
        'div',
        'note',
        'Notes are saved in this browser only — nothing is sent anywhere. Use Copy all or Download to share them.',
      ),
    );
    return wrap;
  }

  // ------------------------------------------------------------- placement

  function onPlace(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    var x = ev.clientX;
    var y = ev.clientY;

    // Hide our own layer so elementFromPoint reports the page underneath.
    host.style.display = 'none';
    var target = document.elementFromPoint(x, y);
    host.style.display = '';

    var d = {
      pos: { x: x, y: y },
      px: x + window.scrollX,
      py: y + window.scrollY,
      nav: navSignature(),
    };
    if (target && target !== document.body && target !== document.documentElement) {
      var rect = target.getBoundingClientRect();
      d.selector = cssPath(target);
      d.label = labelFor(target);
      d.fx = rect.width ? (x - rect.left) / rect.width : 0.5;
      d.fy = rect.height ? (y - rect.top) / rect.height : 0.5;
    } else {
      d.fx = 0.5;
      d.fy = 0.5;
    }

    armed = false;
    openId = null;
    draft = d;
    render();
  }

  // ---------------------------------------------------------------- export

  function when(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch (e) {
      return iso;
    }
  }

  function exportText(then) {
    var lines = [
      '# Preview feedback — ' + document.title,
      '',
      location.href,
      '',
    ];
    notes.forEach(function (note, i) {
      lines.push(
        i + 1 + '. ' + note.body,
        '   — ' + (note.author || 'Anonymous') +
          (note.label ? ' · near “' + note.label + '”' : '') +
          ' · ' + when(note.createdAt),
        '',
      );
    });
    then(lines.join('\n'));
  }

  function copyText(text, button) {
    var done = function () {
      var was = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () {
        button.textContent = was;
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        fallbackCopy(text, done);
      });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      prompt('Copy your feedback:', text);
    }
    document.body.removeChild(ta);
  }

  function download(text) {
    var blob = new Blob([text], { type: 'text/markdown' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'preview-feedback.md';
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // ---------------------------------------------------------------- events

  /** Move existing pins only — never rebuild, so an open composer keeps focus. */
  function reposition() {
    pinEls.forEach(function (entry) {
      var pos = positionOf(entry.note);
      if (!pos) {
        entry.el.style.display = 'none';
        return;
      }
      entry.el.style.display = '';
      entry.el.style.left = pos.x + 'px';
      entry.el.style.top = pos.y + 'px';
    });
  }

  var debug = (window.__hqReviewDebug = { reflows: 0, frames: 0, renders: 0 });

  var pending = false;
  function reflow() {
    debug.reflows++;
    if (pending) return;
    pending = true;
    // setTimeout, not requestAnimationFrame: rAF stops in hidden/background
    // windows, and one queued frame then wedges `pending` so the widget never
    // re-renders again after the window comes back.
    setTimeout(function () {
      pending = false;
      debug.frames++;
      // The harness re-renders on its own (animations, live views). Rebuilding
      // mid-typing would blow away the textarea, so composing wins.
      if (draft || openId) reposition();
      else render();
    }, 33);
  }

  addEventListener('scroll', reflow, true);
  addEventListener('resize', reflow);
  // Click-away: a real click on the page (retargeted events from inside our
  // shadow arrive with target === host, so they don't count) closes the list
  // panel and any open note card. isTrusted-gated so the jump flow's
  // programmatic clicks on app nav controls don't slam the panel mid-jump.
  addEventListener(
    'click',
    function (ev) {
      if (!ev.isTrusted || ev.target === host) return;
      if (!panelOpen && !openId) return;
      panelOpen = false;
      openId = null;
      render();
    },
    true,
  );
  addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && (armed || draft || openId)) {
      armed = false;
      draft = null;
      openId = null;
      render();
    }
  });

  // The harness swaps whole views; re-anchor pins when the DOM settles.
  var observer = new MutationObserver(reflow);
  observer.observe(document.body, { childList: true, subtree: true });

  render();
})();
