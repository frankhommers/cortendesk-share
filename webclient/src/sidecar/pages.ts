// HTML for the guest page and the admin pages. No templates engine: small
// strings with escaping.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const BASE_CSS = `
:root { color-scheme: dark; --bg:#0f1115; --card:#181b22; --line:#2a2f3a; --text:#e8e8e8; --muted:#9aa3b2; --acc:#4f8cff; --bad:#ff6b6b; --ok:#45c46b; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
a { color: var(--acc); }
button, .btn { background:var(--acc); color:#fff; border:0; border-radius:6px; padding:8px 14px; font:inherit; cursor:pointer; }
button.secondary { background:#2a2f3a; }
button.danger { background:#b33a3a; }
button:disabled { opacity:.5; cursor:default; }
input, select { background:#0f1115; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:7px 9px; font:inherit; }
`;

export function sharePage(opts: { thumb: boolean; version: string }): string {
  return `<!DOCTYPE html>
<html lang="en" data-bs-theme="dark" data-rd-theme-pref="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Shared screen</title>
<link rel="shortcut icon" href="/assets/images/cortendesk-sm.svg">
<link rel="stylesheet" href="/assets/vendor/remixicon/remixicon.css">
<link rel="stylesheet" href="/rdclient/app.css?v=${esc(opts.version)}">
<style>
${BASE_CSS}
html, body { height:100%; overflow:hidden; background:#000; }
#rd-root { height:100vh; height:100dvh; }
#rd-root.cd-hide { display:none; }
#cd-msg, #cd-join { position:fixed; inset:0; display:none; align-items:center; justify-content:center; text-align:center; padding:24px; }
#cd-msg.on, #cd-join.on { display:flex; }
#cd-join form { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; width:min(380px, 100%); text-align:left; }
#cd-join h1 { font-size:18px; margin:0 0 4px; }
#cd-join p { color:var(--muted); margin:0 0 18px; }
#cd-join label { display:block; color:var(--muted); margin-bottom:6px; }
#cd-join input { width:100%; margin-bottom:16px; }
#cd-join button { width:100%; }
${opts.thumb ? '#rd-toolbar, #rd-dock, #rd-side, #rd-edge, #rd-stats, .rd-dock, .rd-edge { display:none !important; } #rd-viewport { inset:0 !important; top:0 !important; }' : ''}
</style>
</head>
<body${opts.thumb ? ' class="cd-thumb"' : ''}>
<div id="cd-msg" role="alert"><div><img src="/rdclient/logo.png" alt="" width="48" height="48"><p id="cd-msg-text">This share link is not valid.</p></div></div>
<div id="cd-join"><form id="cd-join-form">
  <h1 id="cd-join-title">Shared screen</h1>
  <p id="cd-join-sub"></p>
  <label for="cd-name">Your name</label>
  <input id="cd-name" maxlength="40" autocomplete="name" placeholder="So the owner knows who is watching">
  <button type="submit">Connect</button>
</form></div>
<div id="rd-root" class="cd-hide">
  <div id="rd-toolbar"></div>
  <div id="rd-viewport"><canvas id="rd-canvas"></canvas><div id="rd-stats"></div><div id="rd-overlay"></div></div>
</div>
<script>
(function () {
  var THUMB = ${opts.thumb ? 'true' : 'false'};
  var VERSION = ${JSON.stringify(opts.version)};
  var token = (location.hash || '').replace(/^#/, '');
  var msg = function (text) {
    document.getElementById('cd-join').classList.remove('on');
    document.getElementById('rd-root').classList.add('cd-hide');
    document.getElementById('cd-msg-text').textContent = text;
    document.getElementById('cd-msg').classList.add('on');
  };
  if (!/^[a-f0-9]{64}$/.test(token)) { msg('This share link is not valid.'); return; }
  // Keep the token out of the address bar history and of screenshots.
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  fetch('/s/info', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ token: token }) })
    .then(function (r) { return r.json().then(function (j) { return r.ok ? j : Promise.reject(j); }); })
    .then(function (info) {
      var start = function (name) {
        document.getElementById('cd-join').classList.remove('on');
        document.getElementById('rd-root').classList.remove('cd-hide');
        var ws = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/gw' + (name ? '?name=' + encodeURIComponent(name) : '');
        window.__RD__ = {
          peerId: '', serverKeyB64: '', wsIdUrl: '', wsRelayUrl: ws,
          myId: 'share-viewer', myName: name || 'Guest', version: VERSION, messages: { share_help: 'This screen is shared with you through a link.' },
          workerUrl: '/rdclient/session.worker.js?v=' + encodeURIComponent(VERSION),
          share: { token: token, label: info.label, deviceName: info.device_name, expiresAt: info.expires_at, permissions: info.permissions }
        };
        document.title = (info.device_name || info.label) + ' — shared screen';
        var load = function () { import('/rdclient/app.js?v=' + encodeURIComponent(VERSION)).catch(function () { msg('The viewer could not load.'); }); };
        // The toolbar picks icon font or SVG once, so let the font load first.
        try { document.fonts.load('16px remixicon').then(load, load); } catch (e) { load(); }
      };
      if (THUMB) { start(''); return; }
      document.getElementById('cd-join-title').textContent = info.label || 'Shared screen';
      document.getElementById('cd-join-sub').textContent = (info.device_name ? info.device_name + ' · ' : '') + 'until ' + new Date(info.expires_at * 1000).toLocaleString();
      var saved = ''; try { saved = localStorage.getItem('cd-share-name') || ''; } catch (e) {}
      var input = document.getElementById('cd-name'); input.value = saved;
      document.getElementById('cd-join').classList.add('on');
      input.focus();
      document.getElementById('cd-join-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var name = input.value.trim().slice(0, 40);
        try { localStorage.setItem('cd-share-name', name); } catch (e2) {}
        start(name);
      });
    })
    .catch(function (j) { msg((j && j.error) || 'This share link is not valid or has ended.'); });
})();
</script>
</body>
</html>`;
}

export function messagePage(title: string, text: string, action?: { href: string; label: string }): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${BASE_CSS} body{display:flex;min-height:100vh;align-items:center;justify-content:center;}
.box{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:440px;text-align:center}</style></head>
<body><div class="box"><h2>${esc(title)}</h2><p>${esc(text)}</p>${action ? `<p><a class="btn" href="${esc(action.href)}">${esc(action.label)}</a></p>` : ''}</div></body></html>`;
}

export function adminPage(opts: { email: string; csrf: string; version: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>CortenDesk Share</title>
<link rel="shortcut icon" href="/assets/images/cortendesk-sm.svg">
<style>
${BASE_CSS}
header { display:flex; align-items:center; gap:12px; padding:14px 24px; border-bottom:1px solid var(--line); }
header h1 { font-size:16px; margin:0; flex:1; }
header .who { color:var(--muted); }
main { max-width:1100px; margin:0 auto; padding:20px 24px 60px; display:grid; gap:20px; }
section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; }
section h2 { font-size:15px; margin:0 0 12px; }
.muted { color:var(--muted); }
.row { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:12px; }
.status { padding:10px 12px; border-radius:8px; border:1px solid var(--line); }
.status.ok { border-color:#2e6b40; } .status.bad { border-color:#7a3434; }
.thumbs { display:flex; flex-wrap:wrap; gap:14px; margin:8px 0 14px; }
.thumb { width:300px; border:2px solid var(--line); border-radius:10px; overflow:hidden; cursor:pointer; background:#000; position:relative; }
.thumb.sel { border-color:var(--acc); box-shadow:0 0 0 2px var(--acc); }
.thumb iframe { width:300px; height:170px; border:0; pointer-events:none; display:block; background:#000; }
.thumb .cap { padding:6px 10px; background:var(--card); font-size:13px; }
.thumb.all { display:flex; align-items:center; justify-content:center; height:204px; }
.rights label { display:inline-flex; gap:6px; align-items:center; margin-right:16px; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:500; }
.created { margin-top:14px; padding:12px; border:1px solid var(--acc); border-radius:8px; display:none; }
.created input { width:100%; margin:8px 0; font-family:ui-monospace, monospace; }
.err { color:var(--bad); }
.pill { display:inline-block; padding:1px 8px; border-radius:99px; background:#2a2f3a; font-size:12px; }
.pill.on { background:#24452e; }
</style>
</head>
<body>
<header>
  <img src="/assets/images/cortendesk-sm.svg" alt="" width="24" height="24">
  <h1>CortenDesk Share</h1>
  <span class="who">${esc(opts.email)}</span>
  <form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${esc(opts.csrf)}"><button class="secondary">Sign out</button></form>
</header>
<main>
  <section id="sec-status"><h2>CortenDesk</h2><div id="status" class="status">Checking…</div></section>

  <section id="sec-new">
    <h2>New share link</h2>
    <div class="row">
      <label>Device <select id="device"><option value="">Loading…</option></select></label>
      <button class="secondary" id="reload-devices" type="button">Refresh</button>
      <span id="pw-state" class="muted"></span>
    </div>
    <div class="row" id="pw-row" style="display:none">
      <input type="password" id="pw" placeholder="Device password (permanent password in RustDesk)" autocomplete="off" style="min-width:320px">
      <button type="button" id="pw-save">Save password</button>
      <button type="button" class="secondary" id="pw-remove">Remove stored password</button>
    </div>
    <div class="row"><button type="button" id="show-screens">Show screens</button><span id="screens-msg" class="muted"></span></div>
    <div class="thumbs" id="thumbs"></div>
    <div class="row rights">
      <span class="muted">Guests may:</span>
      <label><input type="checkbox" checked disabled> watch</label>
      <label><input type="checkbox" id="r-control"> use mouse and keyboard</label>
      <label><input type="checkbox" id="r-clipboard"> clipboard</label>
      <label><input type="checkbox" id="r-files"> files</label>
      <label><input type="checkbox" id="r-audio"> sound</label>
      <label><input type="checkbox" id="r-chat" checked> chat</label>
    </div>
    <div class="row">
      <label>Label <input id="label" maxlength="40" placeholder="e.g. Sprint review"></label>
      <label>Valid for <select id="duration">
        <option value="900">15 minutes</option><option value="3600" selected>1 hour</option><option value="28800">8 hours</option><option value="86400">24 hours</option><option value="604800">7 days</option>
      </select></label>
      <label>Max viewers <input id="max" type="number" min="1" max="20" value="1" style="width:70px"></label>
      <button type="button" id="create">Create link</button>
      <span id="create-msg" class="err"></span>
    </div>
    <div class="created" id="created">
      <strong>Link created.</strong> <span class="muted">It is shown only once.</span>
      <input id="created-url" readonly>
      <button type="button" id="copy">Copy</button>
    </div>
  </section>

  <section><h2>Active links</h2><div id="links" class="muted">Loading…</div></section>
  <section><h2>Log</h2><div id="log" class="muted">Loading…</div></section>
</main>
<script>
(function () {
  var CSRF = ${JSON.stringify(opts.csrf)};
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var api = function (method, path, body) {
    return fetch(path, { method: method, headers: { 'Content-Type': 'application/json', 'X-CSRF': CSRF, 'Accept': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  };
  var devices = [];
  var selected = null; // display index, or 'all'
  var previews = [];

  function fmtTime(t) { return t ? new Date(t * 1000).toLocaleString() : ''; }
  function rightsText(r) {
    var out = ['watch'];
    if (r.control) out.push('control'); if (r.clipboard) out.push('clipboard'); if (r.files) out.push('files'); if (r.audio) out.push('sound'); if (r.chat) out.push('chat');
    return out.join(', ');
  }

  function loadStatus() {
    api('GET', '/admin/api/status').then(function (s) {
      var el = $('status');
      el.className = 'status ' + (s.ok ? 'ok' : 'bad');
      var html = s.ok
        ? 'Connected to <strong>' + esc(s.cdUrl) + '</strong> (' + (s.via === 'sso' ? 'single sign-on' : 'service account') + ').'
        : '<span class="err">' + esc(s.error || 'Not connected.') + '</span>';
      html += '<div class="muted" style="margin-top:6px">This sidecar connects as RustDesk ID <strong>' + esc(s.rustdeskId) + '</strong> ("' + esc(s.deviceName) + '"). If the server only lets approved devices connect, approve this device once in CortenDesk.</div>';
      if (s.ssoAvailable && !s.ok) html += '<div style="margin-top:8px"><button type="button" id="sso">Sign the sidecar in with single sign-on</button> <span id="sso-msg" class="muted"></span></div>';
      if (s.ssoPending) html += '<div class="muted">Waiting for single sign-on… <a target="_blank" rel="noopener" href="' + esc(s.ssoPending.url) + '">open the sign-in page</a></div>';
      el.innerHTML = html;
      var b = $('sso');
      if (b) b.onclick = function () {
        var w = window.open('about:blank', '_blank');
        api('POST', '/admin/api/sso').then(function (r) { if (w) w.location = r.url; else location.href = r.url; setTimeout(loadStatus, 3000); })
          .catch(function (e) { if (w) w.close(); $('sso-msg').textContent = e.message; });
      };
      if (s.ssoPending) setTimeout(loadStatus, 3000);
    }).catch(function (e) { $('status').textContent = e.message; });
  }

  function loadDevices() {
    $('device').innerHTML = '<option value="">Loading…</option>';
    api('GET', '/admin/api/devices').then(function (r) {
      devices = r.devices;
      var sel = $('device');
      if (!devices.length) { sel.innerHTML = '<option value="">No devices visible to the service account</option>'; return; }
      sel.innerHTML = devices.map(function (d) {
        return '<option value="' + esc(d.id) + '">' + esc(d.name) + ' (' + esc(d.id) + ')' + (d.online ? '' : ' · offline') + '</option>';
      }).join('');
      var last = localStorage.getItem('cd-share-device');
      if (last && devices.some(function (d) { return d.id === last; })) sel.value = last;
      deviceChanged();
    }).catch(function (e) { $('device').innerHTML = '<option value="">' + esc(e.message) + '</option>'; });
  }

  function current() { var id = $('device').value; return devices.filter(function (d) { return d.id === id; })[0]; }

  function deviceChanged() {
    clearPreviews();
    var d = current();
    if (!d) return;
    localStorage.setItem('cd-share-device', d.id);
    $('pw-row').style.display = '';
    $('pw-state').textContent = d.hasPassword ? 'Password stored: guests connect without a click.' : 'No password stored: the device asks to accept each guest.';
    $('pw-remove').style.display = d.hasPassword ? '' : 'none';
  }

  function clearPreviews() {
    $('thumbs').innerHTML = '';
    selected = null;
    previews = [];
    $('screens-msg').textContent = '';
  }

  function select(v) {
    selected = v;
    var nodes = $('thumbs').querySelectorAll('.thumb');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('sel', nodes[i].getAttribute('data-v') === String(v));
  }

  $('device').onchange = deviceChanged;
  $('reload-devices').onclick = loadDevices;
  $('pw-save').onclick = function () {
    var d = current(); if (!d) return;
    api('POST', '/admin/api/devices/' + encodeURIComponent(d.id) + '/password', { password: $('pw').value })
      .then(function () { $('pw').value = ''; d.hasPassword = true; deviceChanged(); }).catch(function (e) { alert(e.message); });
  };
  $('pw-remove').onclick = function () {
    var d = current(); if (!d) return;
    api('POST', '/admin/api/devices/' + encodeURIComponent(d.id) + '/password', { password: '' })
      .then(function () { d.hasPassword = false; deviceChanged(); }).catch(function (e) { alert(e.message); });
  };

  $('show-screens').onclick = function () {
    var d = current(); if (!d) return;
    clearPreviews();
    $('screens-msg').textContent = d.hasPassword ? 'Connecting…' : 'Connecting… accept the connection on the device.';
    $('show-screens').disabled = true;
    api('POST', '/admin/api/preview', { device: d.id }).then(function (r) {
      previews = r.displays;
      var html = r.displays.map(function (p) {
        return '<div class="thumb" data-v="' + p.index + '"><iframe src="/p#' + esc(p.token) + '" title="Screen ' + (p.index + 1) + '"></iframe>' +
          '<div class="cap">Screen ' + (p.index + 1) + ' · ' + p.width + '×' + p.height + (p.primary ? ' · main' : '') + (p.name ? ' · ' + esc(p.name) : '') + '</div></div>';
      }).join('');
      if (r.displays.length > 1) html += '<div class="thumb all" data-v="all"><div class="cap" style="background:none">All screens</div></div>';
      $('thumbs').innerHTML = html;
      var nodes = $('thumbs').querySelectorAll('.thumb');
      for (var i = 0; i < nodes.length; i++) nodes[i].onclick = function () { var v = this.getAttribute('data-v'); select(v === 'all' ? 'all' : Number(v)); };
      select(r.displays.length === 1 ? 0 : (r.displays.filter(function (p) { return p.primary; })[0] || r.displays[0]).index);
      $('screens-msg').textContent = 'Click the screen to share. Previews close after a minute.';
      setTimeout(function () {
        var frames = $('thumbs').querySelectorAll('iframe');
        for (var j = 0; j < frames.length; j++) frames[j].src = 'about:blank';
      }, 60000);
    }).catch(function (e) { $('screens-msg').textContent = e.message; })
      .then(function () { $('show-screens').disabled = false; });
  };

  $('create').onclick = function () {
    var d = current(); if (!d) return;
    $('create-msg').textContent = '';
    if (selected === null) { $('create-msg').textContent = 'Show the screens and pick one first.'; return; }
    api('POST', '/admin/api/links', {
      device: d.id, deviceName: d.name, display: selected === 'all' ? null : selected,
      label: $('label').value.trim(), duration: Number($('duration').value), maxViewers: Number($('max').value),
      rights: { control: $('r-control').checked, clipboard: $('r-clipboard').checked, files: $('r-files').checked, audio: $('r-audio').checked, chat: $('r-chat').checked }
    }).then(function (r) {
      $('created').style.display = 'block';
      $('created-url').value = r.url;
      $('created-url').select();
      var frames = $('thumbs').querySelectorAll('iframe');
      for (var j = 0; j < frames.length; j++) frames[j].src = 'about:blank';
      loadLinks();
    }).catch(function (e) { $('create-msg').textContent = e.message; });
  };
  $('copy').onclick = function () {
    var v = $('created-url').value;
    var done = function () { $('copy').textContent = 'Copied'; setTimeout(function () { $('copy').textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(v).then(done);
    else { $('created-url').select(); document.execCommand('copy'); done(); }
  };

  function loadLinks() {
    api('GET', '/admin/api/links').then(function (r) {
      if (!r.links.length) { $('links').innerHTML = 'No active links.'; return; }
      $('links').innerHTML = '<table><tr><th>Label</th><th>Device</th><th>Screen</th><th>Guests may</th><th>Until</th><th>Watching now</th><th></th></tr>' +
        r.links.map(function (l) {
          return '<tr><td>' + esc(l.label) + '</td><td>' + esc(l.deviceName) + '</td><td>' + (l.display === null ? 'all' : 'screen ' + (l.display + 1)) + '</td><td>' + esc(rightsText(l.rights)) +
            '</td><td>' + fmtTime(l.expiresAt) + '</td><td>' + (l.viewers.length ? l.viewers.map(function (v) { return '<span class="pill on">' + esc(v.name || 'Guest') + ' · ' + esc(v.ip) + '</span>'; }).join(' ') : '<span class="muted">nobody</span> <span class="muted">(max ' + l.maxViewers + ')</span>') +
            '</td><td><button class="danger" data-end="' + l.id + '">End</button></td></tr>';
        }).join('') + '</table>';
      var bs = $('links').querySelectorAll('[data-end]');
      for (var i = 0; i < bs.length; i++) bs[i].onclick = function () {
        api('POST', '/admin/api/links/' + this.getAttribute('data-end') + '/end').then(function () { loadLinks(); loadLog(); });
      };
    }).catch(function (e) { $('links').textContent = e.message; });
  }

  function loadLog() {
    api('GET', '/admin/api/log').then(function (r) {
      if (!r.sessions.length) { $('log').innerHTML = 'Nothing yet.'; return; }
      $('log').innerHTML = '<table><tr><th>Started</th><th>Link</th><th>Guest</th><th>IP</th><th>Ended</th><th>Why</th></tr>' +
        r.sessions.map(function (s) {
          return '<tr><td>' + fmtTime(s.started_at) + '</td><td>' + esc(s.kind === 'preview' ? '(preview)' : s.label) + '</td><td>' + esc(s.guest_name || (s.kind === 'preview' ? '' : 'Guest')) + (s.conn !== 'default' ? ' <span class="pill">' + esc(s.conn) + '</span>' : '') +
            '</td><td>' + esc(s.ip) + '</td><td>' + (s.ended_at ? fmtTime(s.ended_at) : '<span class="pill on">live</span>') + '</td><td class="muted">' + esc(s.end_reason || '') + (s.dropped ? ' · ' + s.dropped + ' blocked' : '') + '</td></tr>';
        }).join('') + '</table>';
    }).catch(function (e) { $('log').textContent = e.message; });
  }

  loadStatus(); loadDevices(); loadLinks(); loadLog();
  setInterval(function () { loadLinks(); loadLog(); }, 5000);
})();
</script>
</body>
</html>`;
}
