/**

Cloudflare Worker: Slot Machine Game (single-file)

Serves a full HTML/JS/CSS front-end


Implements server-side spin endpoint with cryptographically secure randomness


Stores player's balance in a signed cookie (HMAC using SECRET_KEY env var)


Deployment notes:

Set a Worker secret binding named SECRET_KEY with a strong secret (e.g. 32+ random bytes base64)


Deploy the Worker (wrangler or Cloudflare dashboard)


Endpoints:

GET /              -> HTML UI


POST /api/spin     -> { bet: number } -> returns spin result and new balance


GET /api/balance   -> returns current balance */



const HTML = (initialBalance) => `<!doctype html>

<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Cloudflare Slot — Worker Edition</title>
  <style>
    :root{--bg:#0f172a;--card:#0b1220;--accent:#ffb703;--muted:#94a3b8}
    html,body{height:100%;margin:0;font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,"Helvetica Neue",Arial}
    body{background:linear-gradient(180deg,#071129 0%,#071827 100%);color:#e6eef8;display:flex;align-items:center;justify-content:center}
    .app{width:980px;max-width:96%;padding:28px;box-sizing:border-box}
    .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
    .brand{font-weight:700;display:flex;gap:12px;align-items:center}
    .brand .logo{width:46px;height:46px;border-radius:10px;background:linear-gradient(135deg,#06b6d4,#7c3aed);display:flex;align-items:center;justify-content:center;font-weight:900}
    .panel{background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));border:1px solid rgba(255,255,255,0.03);padding:18px;border-radius:12px}
    .game{display:flex;gap:18px}
    .left{flex:1}
    .right{width:300px}
    .reels{display:flex;gap:12px;justify-content:center;margin:18px 0}
    .reel{width:120px;height:120px;border-radius:10px;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700}
    .controls{display:flex;gap:8px;flex-wrap:wrap}
    .btn{background:var(--accent);color:#062a3a;padding:10px 14px;border-radius:8px;border:none;font-weight:700;cursor:pointer}
    .btn.secondary{background:transparent;border:1px solid rgba(255,255,255,0.06);color:var(--muted)}
    .balance{font-size:20px}
    .log{margin-top:12px;padding:8px;border-radius:8px;height:140px;overflow:auto;background:rgba(0,0,0,0.2);font-family:monospace}
    footer{margin-top:12px;color:var(--muted);font-size:13px;text-align:center}
    @media(max-width:700px){.game{flex-direction:column}.right{width:auto}}
  </style>
</head>
<body>
  <div class="app">
    <div class="header">
      <div class="brand">
        <div class="logo">SF</div>
        <div>
          <div>Cloudflare Slot — Worker Edition</div>
          <div style="font-size:13px;color:var(--muted)">Secure, deterministic server-side spins</div>
        </div>
      </div>
      <div class="balance panel" id="balance">Balance: <strong id="balVal">${initialBalance}</strong></div>
    </div><div class="panel game">
  <div class="left">
    <div style="text-align:center">
      <div style="font-size:14px;color:var(--muted)">Bet amount</div>
      <div style="margin-top:8px;display:flex;gap:8px;justify-content:center;align-items:center" class="controls">
        <button class="btn secondary" id="betMin">1</button>
        <button class="btn secondary" id="bet10">10</button>
        <button class="btn secondary" id="bet50">50</button>
        <input id="betInput" type="number" value="10" min="1" style="width:120px;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);background:transparent;color:inherit;font-weight:700;text-align:center">
        <button id="spinBtn" class="btn">SPIN</button>
      </div>
    </div>

    <div class="reels" aria-hidden="true">
      <div class="reel" id="r0">—</div>
      <div class="reel" id="r1">—</div>
      <div class="reel" id="r2">—</div>
    </div>

    <div class="log" id="log"></div>
    <footer>Built with Cloudflare Workers · Randomness: Web Crypto</footer>
  </div>

  <div class="right">
    <div class="panel">
      <h3 style="margin:0 0 8px 0">Payout Table</h3>
      <div style="font-family:monospace;white-space:pre-wrap;font-size:13px;color:var(--muted)">
        3x 🍒 => 2x
        3x 🍋 => 3x
        3x 🔔 => 10x
        3x ⭐ => 25x
        3x 💎 => 100x
        Any 3x same => bigger payout!
        Jackpot (3x💎 & random) => 1000x
      </div>
      <hr style="margin:10px 0 12px 0;border:none;border-top:1px solid rgba(255,255,255,0.03)">
      <div style="font-size:13px;color:var(--muted)">Quick actions</div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn secondary" id="addCoins">+100 Coins</button>
        <button class="btn secondary" id="resetBal">Reset</button>
      </div>
    </div>
  </div>
</div>

  </div><script>
const logEl = document.getElementById('log');
const balEl = document.getElementById('balVal');
const rEls = [document.getElementById('r0'),document.getElementById('r1'),document.getElementById('r2')];
let spinning = false;

function appendLog(text){
  logEl.textContent = text + '\n' + logEl.textContent;
}

async function api(path, opts){
  const res = await fetch(path, opts);
  return res.json();
}

function animateReels(final){
  // simple animation
  const symbols = ['🍒','🍋','🔔','⭐','💎'];
  for(let i=0;i<3;i++){
    rEls[i].textContent = '...';
  }
  return new Promise(resolve=>{
    setTimeout(()=>{
      for(let i=0;i<3;i++) rEls[i].textContent = final[i];
      resolve();
    }, 700);
  });
}

document.getElementById('betMin').onclick = ()=> document.getElementById('betInput').value = 1;
document.getElementById('bet10').onclick = ()=> document.getElementById('betInput').value = 10;
document.getElementById('bet50').onclick = ()=> document.getElementById('betInput').value = 50;

async function refreshBalance(){
  try{
    const j = await api('/api/balance');
    balEl.textContent = j.balance;
  }catch(e){console.error(e)}
}

document.getElementById('addCoins').onclick = async ()=>{
  await api('/api/add', {method:'POST'});
  await refreshBalance();
  appendLog('Added 100 coins (free test)');
}

document.getElementById('resetBal').onclick = async ()=>{
  await api('/api/reset', {method:'POST'});
  await refreshBalance();
  appendLog('Balance reset');
}

document.getElementById('spinBtn').onclick = async ()=>{
  if (spinning) return;
  spinning = true;
  const bet = Number(document.getElementById('betInput').value || 0);
  if (!bet || bet <=0){appendLog('Enter a valid bet');spinning=false;return}
  appendLog('Spinning... bet='+bet);
  try{
    const res = await api('/api/spin', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bet})});
    await animateReels(res.reels);
    if(res.error){appendLog('Error: '+res.error);}else{
      appendLog('Result: ' + res.reels.join(' | ') + '  => win: ' + res.win + '  balance: ' + res.balance);
      balEl.textContent = res.balance;
    }
  }catch(e){appendLog('Network error');}
  spinning=false;
}

// initial load
(async()=>{
  try{const j = await api('/api/balance'); balEl.textContent = j.balance;}catch(e){console.error(e)}
})();
</script></body>
</html>
`;// Symbols and payout table (server-side authoritative) const SYMBOLS = [ {sym:'🍒',weight:30,mul:2}, {sym:'🍋',weight:25,mul:3}, {sym:'🔔',weight:20,mul:10}, {sym:'⭐',weight:15,mul:25}, {sym:'💎',weight:10,mul:100} ];

// Helper: pick a symbol index given weights using crypto.getRandomValues async function secureRandomInt(max){ // return integer in [0, max) // using crypto.getRandomValues const array = new Uint32Array(1); crypto.getRandomValues(array); // reduce bias const range = 0xFFFFFFFF + 1; const limit = Math.floor(range / max) * max; let r = array[0]; while(r >= limit){ crypto.getRandomValues(array); r = array[0]; } return r % max; }

async function pickSymbolIndex(){ const total = SYMBOLS.reduce((s,x)=>s+x.weight,0); const rnd = await secureRandomInt(total); let acc = 0; for(let i=0;i<SYMBOLS.length;i++){ acc += SYMBOLS[i].weight; if (rnd < acc) return i; } return SYMBOLS.length-1; }

// Spin logic: returns array of symbols and payout multiplier async function spinOnce(){ const idx0 = await pickSymbolIndex(); const idx1 = await pickSymbolIndex(); const idx2 = await pickSymbolIndex(); const reels = [SYMBOLS[idx0].sym, SYMBOLS[idx1].sym, SYMBOLS[idx2].sym]; let winMul = 0;

// check three of a kind if (idx0 === idx1 && idx1 === idx2){ // jackpot special case if (SYMBOLS[idx0].sym === '💎'){ // tiny chance of super jackpot: use another secure random const rr = await secureRandomInt(1000); if (rr === 0) winMul = 1000; // 0.1% of the diamonds triples -> super else winMul = SYMBOLS[idx0].mul; } else { winMul = SYMBOLS[idx0].mul; } }

return {reels, winMul}; }

// Cookie signing helpers (HMAC using SECRET_KEY) async function importHmacKey(secret){ return await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']); }

async function signValue(key, data){ const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)); // base64url const b = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/+/g,'-').replace(///g,'_').replace(/=+$/,''); return b; }

async function verifySignature(key, data, sigB64){ try{ const expected = await signValue(key,data); return expected === sigB64; }catch(e){return false} }

async function getBalanceFromCookie(request, env){ const cookie = (request.headers.get('Cookie') || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('cfslot=')); if(!cookie) return 1000; // default start try{ const val = cookie.split('=')[1]; const parts = val.split('.'); if(parts.length!==2) return 1000; const data = parts[0]; const sig = parts[1]; const key = await importHmacKey(env.SECRET_KEY || 'dev_secret'); const ok = await verifySignature(key, data, sig); if(!ok) return 1000; const decoded = atob(data); const parsed = JSON.parse(decoded); return Number(parsed.balance) || 1000; }catch(e){return 1000} }

async function makeSetCookieHeader(balance, env){ const key = await importHmacKey(env.SECRET_KEY || 'dev_secret'); const payload = JSON.stringify({balance,ts:Date.now()}); const b64 = btoa(payload); const sig = await signValue(key, b64); const cookie = cfslot=${b64}.${sig}; HttpOnly; Path=/; Max-Age=${60*60*24*30}; SameSite=Lax; return cookie; }

addEventListener('fetch', event=>{ event.respondWith(handle(event.request, event)); });

async function handle(request, event){ const {pathname} = new URL(request.url); const env = event?.env || (typeof SECRET_KEY !== 'undefined' ? {SECRET_KEY} : {});

if(request.method === 'GET' && pathname === '/'){ const bal = await getBalanceFromCookie(request, env); return new Response(HTML(bal), {headers:{'content-type':'text/html; charset=utf-8'}}); }

if(pathname === '/api/balance'){ const bal = await getBalanceFromCookie(request, env); return new Response(JSON.stringify({balance:bal}), {headers:{'content-type':'application/json'}}); }

if(pathname === '/api/add' && request.method === 'POST'){ // friendly dev route — add 100 coins let bal = await getBalanceFromCookie(request, env); bal = Number(bal) + 100; const cookie = await makeSetCookieHeader(bal, env); return new Response(JSON.stringify({balance:bal}), {headers:{'content-type':'application/json','Set-Cookie':cookie}}); }

if(pathname === '/api/reset' && request.method === 'POST'){ const bal = 1000; const cookie = await makeSetCookieHeader(bal, env); return new Response(JSON.stringify({balance:bal}), {headers:{'content-type':'application/json','Set-Cookie':cookie}}); }

if(pathname === '/api/spin' && request.method === 'POST'){ try{ const body = await request.json(); let bet = Number(body.bet || 0); if (!Number.isFinite(bet) || bet <= 0) return new Response(JSON.stringify({error:'Invalid bet'}), {status:400,headers:{'content-type':'application/json'}}); let balance = await getBalanceFromCookie(request, env); if (bet > balance) return new Response(JSON.stringify({error:'Insufficient balance'}), {status:400,headers:{'content-type':'application/json'}});

// perform spin
  const result = await spinOnce();
  const reels = result.reels;
  const winMul = result.winMul || 0;
  const win = Math.floor(bet * winMul);
  balance = balance - bet + win;

  const cookie = await makeSetCookieHeader(balance, env);

  return new Response(JSON.stringify({reels,win,winMul,balance}), {headers:{'content-type':'application/json','Set-Cookie':cookie}});
}catch(e){
  return new Response(JSON.stringify({error:'Invalid request'}), {status:400,headers:{'content-type':'application/json'}});
}

}

return new Response('Not found', {status:404}); }

  
