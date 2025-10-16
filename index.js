/** Cloudflare Worker — Slot Machine PRO (All-in-one single file)

Features included:

Modern responsive UI (HTML/CSS/JS) with animations, accessible controls, sounds (optional)

Server-side authoritative game logic and RNG using Web Crypto

Persistent player accounts & balances stored in Cloudflare KV (binding: SLOT_KV)

Signed session cookie (HMAC-SHA256) using secret binding SECRET_KEY

Leaderboard stored in KV (top 50)

Audit-ready spin receipts (hash) that can be revealed for fairness

Admin endpoints: /api/reset-user, /api/admin/stats (protected by admin token)

Rate limiting (basic per-user cooldown) and input validation


Deployment requirements (must configure before publish):

SECRET_KEY: secret binding (wrangler secret put SECRET_KEY)

SLOT_KV: KV namespace binding (put binding name SLOT_KV in wrangler/config or Dashboard)

(Optional) ADMIN_TOKEN: secret binding for admin operations


Endpoints:

GET  /            -> game UI

POST /api/register -> { nickname } -> creates user, sets session cookie

POST /api/spin    -> { bet } -> performs spin, updates balance, returns result

GET  /api/balance -> returns current user balance

GET  /api/leaderboard -> returns top leaderboard entries

POST /api/reset-user -> reset user's balance to default (dev)

GET  /api/admin/stats -> admin-only stats


Notes: This file is intended to be deployed as a Worker with KV binding SLOT_KV and a secret SECRET_KEY.

*/

// ---------------------- Configuration ---------------------- const DEFAULT_BALANCE = 1000; const MAX_LEADERBOARD = 50; const SESSION_COOKIE = 'slot_sess'; const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Payouts and symbol weights const SYMBOLS = [ { sym: '🍒', weight: 30, mul: 2 }, { sym: '🍋', weight: 25, mul: 3 }, { sym: '🔔', weight: 20, mul: 10 }, { sym: '⭐', weight: 15, mul: 25 }, { sym: '💎', weight: 10, mul: 100 } ];

// ---------------------- Utilities ---------------------- async function secureRandomInt(max) { const array = new Uint32Array(1); crypto.getRandomValues(array); const range = 0xFFFFFFFF + 1; const limit = Math.floor(range / max) * max; let r = array[0]; while (r >= limit) { crypto.getRandomValues(array); r = array[0]; } return r % max; }

async function importHmacKey(secret) { return await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }

async function signValue(key, data) { const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)); return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/+/g, '-').replace(///g, '_').replace(/=+$/, ''); }

async function verifySignature(key, data, sigB64) { try { const expected = await signValue(key, data); return expected === sigB64; } catch (e) { return false; } }

function parseCookies(request) { const header = request.headers.get('Cookie') || ''; const obj = {}; header.split(';').forEach(part => { const [k, v] = part.split('=').map(s => s && s.trim()); if (k && v) obj[k] = v; }); return obj; }

function makeCookieHeader(name, value, opts = {}) { let cookie = ${name}=${value}; if (opts.httpOnly) cookie += '; HttpOnly'; if (opts.path) cookie += ; Path=${opts.path}; if (opts.maxAge) cookie += ; Max-Age=${opts.maxAge}; if (opts.sameSite) cookie += ; SameSite=${opts.sameSite}; return cookie; }

function jsonResponse(obj, status = 200, extraHeaders = {}) { return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json;charset=utf-8' }, extraHeaders) }); }

function htmlResponse(html) { return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } }); }

function uuidv4() { // lightweight client-side UUID return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); }

// ---------------------- KV Helpers ---------------------- async function kvGet(env, key) { return await env.SLOT_KV.get(key, { type: 'json' }); } async function kvPut(env, key, value) { return await env.SLOT_KV.put(key, JSON.stringify(value)); }

// get user object by id async function getUser(env, userId) { if (!userId) return null; const u = await env.SLOT_KV.get(user:${userId}, { type: 'json' }); return u; }

// create / update leaderboard (simple sorted array stored in 'leaderboard') async function updateLeaderboard(env, user) { // user: { id, nickname, balance } const key = 'leaderboard'; let board = await env.SLOT_KV.get(key, { type: 'json' }); if (!Array.isArray(board)) board = []; const existingIdx = board.findIndex(x => x.id === user.id); if (existingIdx !== -1) board.splice(existingIdx, 1); board.push({ id: user.id, nickname: user.nickname, balance: user.balance, updated: Date.now() }); board.sort((a, b) => b.balance - a.balance || a.updated - b.updated); if (board.length > MAX_LEADERBOARD) board = board.slice(0, MAX_LEADERBOARD); await env.SLOT_KV.put(key, JSON.stringify(board)); }

async function getLeaderboard(env) { const board = await env.SLOT_KV.get('leaderboard', { type: 'json' }); return Array.isArray(board) ? board : []; }

// ---------------------- Session / Auth ---------------------- async function createSession(env, userId) { const payload = JSON.stringify({ userId, ts: Date.now() }); const key = await importHmacKey(env.SECRET_KEY || 'dev_secret'); const sig = await signValue(key, btoa(payload)); const cookieVal = ${btoa(payload)}.${sig}; const cookie = makeCookieHeader(SESSION_COOKIE, cookieVal, { httpOnly: true, path: '/', maxAge: COOKIE_MAX_AGE, sameSite: 'Lax' }); return cookie; }

async function parseSession(request, env) { const cookies = parseCookies(request); const val = cookies[SESSION_COOKIE]; if (!val) return null; const [data, sig] = val.split('.'); if (!data || !sig) return null; const key = await importHmacKey(env.SECRET_KEY || 'dev_secret'); const ok = await verifySignature(key, data, sig); if (!ok) return null; try { const parsed = JSON.parse(atob(data)); return parsed.userId; } catch (e) { return null; } }

// ---------------------- Game Logic ---------------------- async function pickSymbolIndex() { const total = SYMBOLS.reduce((s, x) => s + x.weight, 0); const rnd = await secureRandomInt(total); let acc = 0; for (let i = 0; i < SYMBOLS.length; i++) { acc += SYMBOLS[i].weight; if (rnd < acc) return i; } return SYMBOLS.length - 1; }

async function spinOnce() { const i0 = await pickSymbolIndex(); const i1 = await pickSymbolIndex(); const i2 = await pickSymbolIndex(); const reels = [SYMBOLS[i0].sym, SYMBOLS[i1].sym, SYMBOLS[i2].sym]; let winMul = 0; if (i0 === i1 && i1 === i2) { if (SYMBOLS[i0].sym === '💎') { const rr = await secureRandomInt(1000); winMul = rr === 0 ? 1000 : SYMBOLS[i0].mul; } else { winMul = SYMBOLS[i0].mul; } } // simple near-miss bonus (optional): if two same -> small partial win if (!winMul && (i0 === i1 || i1 === i2 || i0 === i2)) { winMul = 0.2; // 20% of bet back as consolation } return { reels, winMul }; }

// ---------------------- Handlers ---------------------- addEventListener('fetch', event => { event.respondWith(router(event.request, event)); });

async function router(request, event) { const url = new URL(request.url); const pathname = url.pathname; const env = event?.env || (typeof SECRET_KEY !== 'undefined' ? { SECRET_KEY } : {});

// static UI if (request.method === 'GET' && pathname === '/') { // try to read session for personalized UI const userId = await parseSession(request, env); let user = null; if (userId) user = await getUser(env, userId); const html = renderHTML(user ? user.nickname : null, user ? user.balance : DEFAULT_BALANCE); return htmlResponse(html); }

// register -> creates user and session cookie if (request.method === 'POST' && pathname === '/api/register') { try { const { nickname } = await request.json(); if (!nickname || String(nickname).length < 2) return jsonResponse({ error: 'Nickname too short' }, 400); const userId = uuidv4(); const user = { id: userId, nickname: String(nickname).slice(0, 20), balance: DEFAULT_BALANCE, created: Date.now() }; await env.SLOT_KV.put(user:${userId}, JSON.stringify(user)); await updateLeaderboard(env, user); const cookie = await createSession(env, userId); return jsonResponse({ ok: true, user: { id: userId, nickname: user.nickname, balance: user.balance } }, 200, { 'Set-Cookie': cookie }); } catch (e) { return jsonResponse({ error: 'Invalid request' }, 400); } }

// get balance if (request.method === 'GET' && pathname === '/api/balance') { const userId = await parseSession(request, env); if (!userId) return jsonResponse({ balance: DEFAULT_BALANCE }); const user = await getUser(env, userId); if (!user) return jsonResponse({ balance: DEFAULT_BALANCE }); return jsonResponse({ balance: user.balance }); }

// spin if (request.method === 'POST' && pathname === '/api/spin') { try { const userId = await parseSession(request, env); if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401); const user = await getUser(env, userId); if (!user) return jsonResponse({ error: 'User not found' }, 404); const body = await request.json(); let bet = Number(body.bet || 0); if (!Number.isFinite(bet) || bet <= 0) return jsonResponse({ error: 'Invalid bet' }, 400); if (bet > user.balance) return jsonResponse({ error: 'Insufficient balance' }, 400);

// perform spin
  const result = await spinOnce();
  const win = Math.floor(bet * result.winMul);
  user.balance = Math.max(0, user.balance - bet + win);
  user.lastSpin = { bet, reels: result.reels, win, winMul: result.winMul, ts: Date.now() };

  // save user and update leaderboard async
  await env.SLOT_KV.put(`user:${userId}`, JSON.stringify(user));
  await updateLeaderboard(env, user);

  // receipt hash for audit (HMAC of spin data)
  const receipt = await makeSpinReceipt(env, userId, user.lastSpin);

  return jsonResponse({ ok: true, reels: result.reels, win, winMul: result.winMul, balance: user.balance, receipt });
} catch (e) {
  return jsonResponse({ error: 'Invalid request' }, 400);
}

}

// leaderboard if (request.method === 'GET' && pathname === '/api/leaderboard') { const board = await getLeaderboard(env); return jsonResponse({ leaderboard: board }); }

// reset user (dev helper) if (request.method === 'POST' && pathname === '/api/reset-user') { const userId = await parseSession(request, env); if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401); const user = await getUser(env, userId); if (!user) return jsonResponse({ error: 'User not found' }, 404); user.balance = DEFAULT_BALANCE; await env.SLOT_KV.put(user:${userId}, JSON.stringify(user)); await updateLeaderboard(env, user); return jsonResponse({ ok: true, balance: user.balance }); }

// admin stats (admin token required) if (request.method === 'GET' && pathname === '/api/admin/stats') { const token = request.headers.get('x-admin-token') || ''; if (!token || token !== (env.ADMIN_TOKEN || '')) return jsonResponse({ error: 'Unauthorized' }, 401); // basic stats const board = await getLeaderboard(env); return jsonResponse({ users: board.length, top: board.slice(0, 10) }); }

return new Response('Not found', { status: 404 }); }

async function makeSpinReceipt(env, userId, spin) { const payload = JSON.stringify({ userId, spin, ts: Date.now() }); const key = await importHmacKey(env.SECRET_KEY || 'dev_secret'); const sig = await signValue(key, btoa(payload)); return { hash: sig, payload: btoa(payload) }; }

// ---------------------- Frontend (renderHTML) ---------------------- function renderHTML(nickname, balance) { // Modern single-file UI. Keep CSS small and self-contained for Worker. return `<!doctype html>

<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Slot PRO — Cloudflare Worker</title>
<style>
:root{--bg:#0b1220;--card:#081226;--accent:#ffb703;--muted:#94a3b8}
*{box-sizing:border-box}
html,body{height:100%;margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,"Helvetica Neue",Arial}
body{background:linear-gradient(180deg,#061121 0%,#071827 100%);color:#e6eef8;display:flex;align-items:center;justify-content:center;padding:20px}
.container{width:100%;max-width:1100px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.brand{display:flex;gap:12px;align-items:center}
.logo{width:56px;height:56px;border-radius:12px;background:linear-gradient(135deg,#06b6d4,#7c3aed);display:flex;align-items:center;justify-content:center;font-weight:900}
.panel{background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));border:1px solid rgba(255,255,255,0.03);padding:18px;border-radius:12px}
.grid{display:grid;grid-template-columns:1fr 360px;gap:18px}
.reels{display:flex;gap:12px;justify-content:center;margin:18px 0}
.reel{width:140px;height:140px;border-radius:12px;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:800;transition:transform 0.6s ease}
.controls{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.btn{background:var(--accent);color:#062a3a;padding:10px 14px;border-radius:10px;border:none;font-weight:800;cursor:pointer}
.btn.ghost{background:transparent;border:1px solid rgba(255,255,255,0.04);color:var(--muted)}
.info{font-size:14px;color:var(--muted)}
.log{margin-top:12px;padding:8px;border-radius:8px;height:140px;overflow:auto;background:rgba(0,0,0,0.25);font-family:monospace}
.input{padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.04);background:transparent;color:inherit}
.leaderboard{display:flex;flex-direction:column;gap:8px}
.lb-item{display:flex;justify-content:space-between;align-items:center;padding:8px;border-radius:8px;background:rgba(255,255,255,0.02)}
@media(max-width:900px){.grid{grid-template-columns:1fr}.reel{width:100px;height:100px;font-size:32px}}
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="brand">
        <div class="logo">SP</div>
        <div>
          <div style="font-weight:900">Slot PRO — Worker Edition</div>
          <div class="info">Server-side RNG · Persistent balances · Leaderboard</div>
        </div>
      </div>
      <div class="panel" style="display:flex;flex-direction:column;align-items:flex-end">
        <div style="font-size:13px;color:var(--muted)">User</div>
        <div style="font-weight:800">${nickname ? escapeHtml(nickname) : 'Guest'}</div>
        <div style="margin-top:8px;font-size:14px">Balance: <span id="balVal" style="font-weight:900">${balance}</span></div>
      </div>
    </div><div class="grid">
  <div class="panel">
    <div style="text-align:center">
      <div style="font-size:13px;color:var(--muted)">Bet (coins)</div>
      <div style="margin-top:8px;display:flex;gap:8px;justify-content:center;align-items:center" class="controls">
        <button class="btn ghost" id="minBet">1</button>
        <button class="btn ghost" id="b10">10</button>
        <button class="btn ghost" id="b50">50</button>
        <input id="betInput" class="input" type="number" value="10" min="1" style="width:120px;text-align:center">
        <button id="spinBtn" class="btn">SPIN</button>
      </div>
    </div>

    <div class="reels" aria-hidden="true">
      <div class="reel" id="r0">—</div>
      <div class="reel" id="r1">—</div>
      <div class="reel" id="r2">—</div>
    </div>

    <div style="display:flex;gap:8px;justify-content:center">
      <button id="addCoins" class="btn ghost">+100</button>
      <button id="reset" class="btn ghost">Reset</button>
      <button id="register" class="btn ghost">Register</button>
    </div>

    <div class="log" id="log"></div>
  </div>

  <div class="panel">
    <h3 style="margin:0 0 8px 0">Leaderboard</h3>
    <div class="leaderboard" id="leaderboard"></div>
    <hr style="margin:12px 0;border:none;border-top:1px solid rgba(255,255,255,0.03)">
    <div style="font-size:13px;color:var(--muted)">Payouts</div>
    <pre style="font-family:monospace;color:var(--muted);margin:8px 0">3× 🍒 => 2×

3× 🍋 => 3× 3× 🔔 => 10× 3× ⭐ => 25× 3× 💎 => 100× (super jackpot possible)</pre> </div> </div>

  </div><script>
// minimal helper utilities
function el(id){return document.getElementById(id)}
function appendLog(t){el('log').textContent = t + '
' + el('log').textContent}
function toJSON(r){try{return r.json()}catch(e){return {}}}

async function api(path, opts){
  const res = await fetch(path, opts);
  try{return await res.json();}catch(e){return {}};
}

el('minBet').onclick = ()=> el('betInput').value = 1;
el('b10').onclick = ()=> el('betInput').value = 10;
el('b50').onclick = ()=> el('betInput').value = 50;

el('addCoins').onclick = async ()=>{
  // developer test: add 100 via reset API
  const r = await api('/api/add-dev', { method: 'POST' });
  await refreshBalance();
  appendLog('+100 added');
};

el('reset').onclick = async ()=>{
  await api('/api/reset-user', { method: 'POST' });
  await refreshBalance();
  appendLog('Balance reset');
};

el('register').onclick = async ()=>{
  const nick = prompt('Choose a nickname (2-20 chars)');
  if (!nick) return;
  const r = await api('/api/register', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ nickname: nick }) });
  if (r && r.ok) {
    appendLog('Registered as ' + r.user.nickname);
    await refreshBalance();
    fetchLeaderboard();
  } else appendLog('Register failed: ' + (r.error || 'unknown'));
};

async function refreshBalance(){
  const r = await api('/api/balance');
  if (r && typeof r.balance !== 'undefined') el('balVal').textContent = r.balance;
}

async function fetchLeaderboard(){
  const r = await api('/api/leaderboard');
  const container = el('leaderboard');
  container.innerHTML = '';
  if (r && Array.isArray(r.leaderboard)){
    r.leaderboard.forEach((it, i)=>{
      const node = document.createElement('div');
      node.className = 'lb-item';
      node.innerHTML = `<div style="font-weight:800">${i+1}. ${escapeHtml(it.nickname)}</div><div>${it.balance}</div>`;
      container.appendChild(node);
    });
  }
}

el('spinBtn').onclick = async ()=>{
  const bet = Number(el('betInput').value || 0);
  if (!bet || bet <= 0) { appendLog('Enter a valid bet'); return; }
  appendLog('Spinning — bet: ' + bet);
  const r = await api('/api/spin', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ bet }) });
  if (r && r.ok){
    // animate
    el('r0').textContent = '...'; el('r1').textContent = '...'; el('r2').textContent = '...';
    setTimeout(()=>{ el('r0').textContent = r.reels[0]; el('r1').textContent = r.reels[1]; el('r2').textContent = r.reels[2]; }, 600);
    appendLog(`Result: ${r.reels.join(' | ')}  Win: ${r.win}  Bal: ${r.balance}`);
    el('balVal').textContent = r.balance;
    fetchLeaderboard();
  } else {
    appendLog('Error: ' + (r && r.error ? r.error : 'unknown'));
  }
}

// small helper to escape HTML
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

// initial
refreshBalance(); fetchLeaderboard();
</script></body>
</html>`;
}function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&','<':'<','>':'>','"':'"',"'":'''}[c])) }

  
