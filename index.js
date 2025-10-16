// Cloudflare Worker (Module) - Slot Game Pragmatic-style (Demo)
// Save as `index.js` in a Worker (module type).
// - GET /  -> serves HTML game
// - POST /spin -> returns JSON { reels: [...], rows: 3, payoutMultiplier, winAmount, debug }
// Deploy: Cloudflare Workers (module)

const SYMBOLS = [
  { id: "diamond", label: "Diamond", weight: 2, multiplier: 500 },
  { id: "seven", label: "7", weight: 6, multiplier: 200 },
  { id: "star", label: "Star", weight: 10, multiplier: 100 },
  { id: "bell", label: "Bell", weight: 14, multiplier: 60 },
  { id: "lemon", label: "Lemon", weight: 22, multiplier: 30 },
  { id: "cherry", label: "Cherry", weight: 46, multiplier: 10 }
];
// total weight = sum weights -> used by weighted RNG
const TOTAL_WEIGHT = SYMBOLS.reduce((s, x) => s + x.weight, 0);

// Configurable RTP-ish control (for demo): average payout fraction (0.92 -> house edge 8%)
// NOTE: This simple demo doesn't guarantee exact RTP; for production use a validated payout engine.
const TARGET_PAYOUT_RATE = 0.92;

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(req) {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/spin") {
    try {
      const body = await req.json().catch(() => ({}));
      // Expected: { bet: number, clientSeed?: string, turbo?: bool }
      const bet = Math.max(1, Math.floor(Number(body.bet) || 1));
      // Use server RNG (crypto)
      const spinResult = serverSpin(bet);
      return jsonResponse(spinResult);
    } catch (err) {
      return jsonResponse({ error: "invalid_request", message: String(err) }, 400);
    }
  }

  // Serve HTML + inline assets for any other GET
  if (req.method === "GET") {
    return new Response(HTML_PAGE, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
}

// ------- Server-side spin logic -------
function serverSpin(bet) {
  // 5 reels, 3 rows (center is the payline row)
  const reels = 5;
  const rows = 3;

  // We will produce a matrix [reel][row] (top->bottom)
  const matrix = [];
  for (let r = 0; r < reels; r++) {
    matrix[r] = [];
    for (let y = 0; y < rows; y++) {
      matrix[r].push(weightedRandomSymbolId());
    }
  }

  // Evaluate wins on center horizontal payline (row index 1) and basic three/some combos
  const centerLine = matrix.map((col) => col[1]); // array of symbol ids per reel on center row

  // Simple pay evaluation:
  // - if 5 of kind -> highest multiplier
  // - if 4 of kind (left-to-right contiguous) -> somewhat
  // - if 3 of kind -> base multiplier
  // - two of kind -> small consolation
  // This demo uses only center line for simplicity (can be expanded to many paylines)
  const counts = centerLine.reduce((acc, s) => ((acc[s] = (acc[s] || 0) + 1), acc), {});
  let payoutMultiplier = 0;
  let winningSymbol = null;

  for (const [sym, cnt] of Object.entries(counts)) {
    if (cnt >= 3) {
      // find symbol's multiplier
      const sObj = SYMBOLS.find((x) => x.id === sym);
      if (sObj) {
        // scale multiplier by count: 3->base, 4-> 2× base, 5-> 4× base (example scaling)
        const scale = cnt === 3 ? 1 : cnt === 4 ? 2 : 4;
        payoutMultiplier = Math.max(payoutMultiplier, sObj.multiplier * scale);
        winningSymbol = sym;
      }
    }
  }

  // two-of-kind consolation
  if (payoutMultiplier === 0) {
    for (const [sym, cnt] of Object.entries(counts)) {
      if (cnt === 2) {
        payoutMultiplier = Math.floor(5); // small constant multiplier for two-of-kind
        winningSymbol = sym;
        break;
      }
    }
  }

  // For "house-edge control", we implement a light rejection sampling:
  // If payout looks too large relative to target RTP and bet, we may re-spin (limited attempts).
  // WARNING: This is a simplified demo and not a certified RTP controller.
  let winAmount = Math.floor(bet * payoutMultiplier);
  // Quick control: if winAmount / bet is absurdly high relative to TARGET_PAYOUT_RATE, re-roll few times
  // Bound attempts
  let attempt = 0;
  while (attempt < 6 && shouldRejectOutcome(winAmount, bet)) {
    // re-generate
    attempt++;
    for (let r = 0; r < reels; r++) {
      for (let y = 0; y < rows; y++) {
        matrix[r][y] = weightedRandomSymbolId();
      }
    }
    const newCenter = matrix.map((col) => col[1]);
    const newCounts = newCenter.reduce((acc, s) => ((acc[s] = (acc[s] || 0) + 1), acc), {});
    payoutMultiplier = 0;
    winningSymbol = null;
    for (const [sym, cnt] of Object.entries(newCounts)) {
      if (cnt >= 3) {
        const sObj = SYMBOLS.find((x) => x.id === sym);
        if (sObj) {
          const scale = cnt === 3 ? 1 : cnt === 4 ? 2 : 4;
          payoutMultiplier = Math.max(payoutMultiplier, sObj.multiplier * scale);
          winningSymbol = sym;
        }
      }
    }
    if (payoutMultiplier === 0) {
      for (const [sym, cnt] of Object.entries(newCounts)) {
        if (cnt === 2) {
          payoutMultiplier = Math.floor(5);
          winningSymbol = sym;
          break;
        }
      }
    }
    winAmount = Math.floor(bet * payoutMultiplier);
  }

  // Build readable matrix with labels
  const matrixLabeled = matrix.map((col) => col.map((id) => {
    const s = SYMBOLS.find(x => x.id === id);
    return { id, label: s ? s.label : id };
  }));

  const debug = {
    attempts: attempt + 1,
    payoutMultiplier,
    winningSymbol,
    centerLine,
  };

  return {
    reels: matrixLabeled,
    rows,
    bet,
    payoutMultiplier,
    winAmount,
    debug
  };
}

function shouldRejectOutcome(winAmount, bet) {
  // Simple heuristic: allow base variance but prevent extreme wins too often relative to bet.
  // If winAmount > bet * (some threshold), reject with probability depending on target RTP.
  if (winAmount === 0) return false;
  const ratio = winAmount / bet;
  // If ratio is huge, more likely to reject. This is only a demo.
  if (ratio > 200) return Math.random() < 0.95;
  if (ratio > 100) return Math.random() < 0.8;
  if (ratio > 50) return Math.random() < 0.6;
  // else accept
  return false;
}

function weightedRandomSymbolId() {
  // crypto-random 32-bit, map into [0, TOTAL_WEIGHT)
  const r = secureRandomInt(TOTAL_WEIGHT);
  let acc = 0;
  for (const s of SYMBOLS) {
    acc += s.weight;
    if (r < acc) return s.id;
  }
  // fallback
  return SYMBOLS[SYMBOLS.length - 1].id;
}

function secureRandomInt(max) {
  // returns int in [0, max)
  // Use crypto.getRandomValues
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  // Convert to float in [0,1)
  const x = array[0] / 0x100000000;
  return Math.floor(x * max);
}

// ------- Utilities -------
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ------- Frontend HTML (inline, minimal external deps) -------
const HTML_PAGE = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Pragmatic-style Slot — Worker Demo</title>
<style>
  :root{
    --bg:#061022; --panel:#0c1724; --accent:#f59e0b; --muted:#94a3b8; --glass: rgba(255,255,255,0.03);
    --win:#16a34a; --bigwin:#ffb020;
  }
  *{box-sizing:border-box}
  body{margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background: radial-gradient(circle at 20% 30%, #08203a 0%, #040615 60%); font-family: Inter, system-ui, Arial; color:#e6eef8}
  .wrap{width:1100px; max-width:98%; padding:20px;}
  .top{display:flex; justify-content:space-between; align-items:center; gap:12px}
  h1{margin:0; font-size:20px}
  .machine-area{display:flex; gap:16px; margin-top:16px}
  .machine{background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)); border-radius:14px; padding:18px; display:flex; gap:18px; align-items:center; box-shadow: 0 10px 30px rgba(2,6,23,0.6);}
  .reels{display:grid; grid-template-columns: repeat(5, 1fr); gap:8px; width:740px;}
  .reel{height:220px; background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.12)); border-radius:12px; overflow:hidden; position:relative; display:flex; align-items:center; justify-content:center}
  .strip{position:absolute; left:0; right:0; top:0; transition: transform 1s cubic-bezier(.18,.9,.32,1); display:flex; flex-direction:column; align-items:center;}
  .cell{height:220px; width:100%; display:flex; align-items:center; justify-content:center; font-size:46px; font-weight:700; text-shadow: 0 6px 18px rgba(0,0,0,0.6);}
  .payline{position:absolute; left:0; right:0; top:33.33%; height:4px; background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity:0.95}
  .control-panel{width:300px; display:flex; flex-direction:column; gap:10px}
  .panel-box{background:rgba(255,255,255,0.02); padding:12px; border-radius:10px}
  button{border:0; background:var(--accent); color:#071022; padding:10px 12px; border-radius:10px; font-weight:700; cursor:pointer}
  .secondary{background:transparent; color:var(--muted); border:1px solid rgba(255,255,255,0.04)}
  input[type=number]{width:100%; padding:8px; border-radius:8px; background:transparent; border:1px solid rgba(255,255,255,0.04); color:inherit}
  .muted{color:var(--muted); font-size:13px}
  .bigwin{position:fixed; left:50%; top:18%; transform:translateX(-50%); background:linear-gradient(90deg,#ffefc0,#ffd769); color:#301400; padding:18px 30px; border-radius:16px; font-size:28px; font-weight:900; box-shadow:0 18px 60px rgba(255,183,60,0.18); display:none; z-index:9999}
  .hud{display:flex; gap:8px; align-items:center}
  .chip{background:rgba(0,0,0,0.25); padding:8px 10px; border-radius:10px}
  @media(max-width:1100px){ .reels{width:520px} .cell{font-size:34px} .reel{height:160px} .cell{height:160px} }
  @media(max-width:760px){ .machine-area{flex-direction:column} .reels{width:100%} .control-panel{width:100%} }
</style>
</head>
<body>
<div class="bigwin" id="bigwin">BIG WIN!</div>
<div class="wrap">
  <div class="top">
    <div>
      <h1>🎰 Pragmatic-style Slot — Worker Demo</h1>
      <div class="muted">Server RNG (Worker) • 5 reels × 3 rows • Secure demo</div>
    </div>
    <div class="hud">
      <div class="chip">Balance: <strong id="balance">10000</strong></div>
      <div class="chip">Bet: <strong id="betShow">10</strong></div>
      <div class="chip">Wins: <strong id="wins">0</strong></div>
    </div>
  </div>

  <div class="machine-area">
    <div class="machine">
      <div class="reels" id="reels">
        <!-- 5 reel containers -->
        <div class="reel" data-i="0"><div class="strip" id="strip-0"></div><div class="payline"></div></div>
        <div class="reel" data-i="1"><div class="strip" id="strip-1"></div><div class="payline"></div></div>
        <div class="reel" data-i="2"><div class="strip" id="strip-2"></div><div class="payline"></div></div>
        <div class="reel" data-i="3"><div class="strip" id="strip-3"></div><div class="payline"></div></div>
        <div class="reel" data-i="4"><div class="strip" id="strip-4"></div><div class="payline"></div></div>
      </div>

      <div style="display:flex; flex-direction:column; gap:8px; margin-left:12px;">
        <button id="spinBtn">SPIN</button>
        <button id="autoBtn" class="secondary">AUTO</button>
        <button id="turboBtn" class="secondary">TURBO</button>
      </div>
    </div>

    <div class="control-panel">
      <div class="panel-box">
        <div class="muted">Set Bet</div>
        <input type="number" id="betInput" value="10" min="1" />
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button id="plus">+10</button><button id="minus" class="secondary">-10</button>
        </div>
      </div>

      <div class="panel-box">
        <div class="muted">Options</div>
        <label><input type="checkbox" id="sound" checked> Sound</label><br>
        <label class="muted">Autoplay Delay: <input id="delay" type="number" value="800" min="100" step="100"/> ms</label>
      </div>

      <div class="panel-box">
        <div class="muted">Paytable (center line)</div>
        <div id="paytable" class="muted"></div>
      </div>
    </div>
  </div>
</div>

<script>
(() => {
  const SYMBOLS = [
    { id: "diamond", label: "💎" },
    { id: "seven", label: "7️⃣" },
    { id: "star", label: "⭐" },
    { id: "bell", label: "🔔" },
    { id: "lemon", label: "🍋" },
    { id: "cherry", label: "🍒" },
  ];
  const paytableMap = { diamond:500, seven:200, star:100, bell:60, lemon:30, cherry:10 };

  let balance = 10000;
  let bet = 10;
  let wins = 0;
  let auto = false;
  let turbo = false;

  const balanceEl = document.getElementById('balance');
  const betShow = document.getElementById('betShow');
  const winsEl = document.getElementById('wins');
  const spinBtn = document.getElementById('spinBtn');
  const autoBtn = document.getElementById('autoBtn');
  const turboBtn = document.getElementById('turboBtn');
  const betInput = document.getElementById('betInput');
  const plus = document.getElementById('plus');
  const minus = document.getElementById('minus');
  const delayInput = document.getElementById('delay');
  const soundToggle = document.getElementById('sound');
  const bigwinEl = document.getElementById('bigwin');

  const stripEls = [0,1,2,3,4].map(i => document.getElementById('strip-'+i));
  const baseDur = 900;

  function renderPaytable(){
    const el = document.getElementById('paytable');
    el.innerHTML = Object.keys(paytableMap).map(k => \`\${SYMBOLS.find(s=>s.id===k)?.label || k} : ×\${paytableMap[k]}\`).join('<br>');
  }

  function updateHUD(){ balanceEl.textContent = balance; betShow.textContent = bet; winsEl.textContent = wins; betInput.value = bet; }

  function buildStrips(){ // simple repeated symbols for visual
    stripEls.forEach((strip) => {
      strip.innerHTML = '';
      for(let rep=0; rep<8; rep++){
        for(const s of SYMBOLS){
          const div = document.createElement('div');
          div.className = 'cell';
          div.textContent = s.label;
          strip.appendChild(div);
        }
      }
    });
  }

  async function doSpin() {
    if (bet > balance) { alert('Saldo tidak cukup'); return; }
    balance -= bet; updateHUD();
    // ask worker /spin for result
    try {
      const resp = await fetch('/spin', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ bet }) });
      const data = await resp.json();
      if (data.error) { alert(data.message || 'Server error'); return; }

      // animate strips to their result
      // matrix: data.reels is [reel][row]{id,label}
      for (let i=0;i<5;i++){
        const strip = stripEls[i];
        // find index of a center occurrence of the symbol inside our repeated strip
        const targetId = data.reels[i][1].id; // center row
        // find symbol index in SYMBOLS to compute offset
        const symIndex = SYMBOLS.findIndex(s => s.id === targetId);
        const symbolHeight = (strip.children[0] && strip.children[0].offsetHeight) || 220;
        // place into middle repetition so animation looks nice
        const repeatCount = 8;
        const midRepeat = Math.floor(repeatCount/2);
        const indexInStrip = symIndex + SYMBOLS.length * midRepeat;
        const totalHeight = SYMBOLS.length * repeatCount * symbolHeight;
        const cycles = turbo ? 1 + Math.floor(Math.random()*2) : 2 + Math.floor(Math.random()*3);
        const offset = -(cycles * totalHeight) - (indexInStrip * symbolHeight);
        // set duration with stagger
        const duration = (baseDur + i*130) * (turbo?0.6:1);
        strip.style.transition = \`transform \${duration}ms cubic-bezier(.18,.9,.32,1)\`;
        // small timeout to ensure transition applied
        setTimeout(()=> strip.style.transform = \`translateY(\${offset}px)\`, 30);
      }

      // wait for longest animation
      await new Promise(r => setTimeout(r, (baseDur + 4*130) * (turbo?0.6:1) + 120));

      // display win/loss
      const win = data.winAmount || 0;
      if (win > 0) {
        balance += win;
        wins += win;
        updateHUD();
        showWin(win, data.payoutMultiplier);
      } else {
        updateHUD();
      }

      // snap back strips visually to original repeat (without transition) after short delay
      setTimeout(()=> {
        stripEls.forEach(s => { s.style.transition = 'none'; s.style.transform = 'translateY(0px)'; });
      }, 300);

    } catch (e) {
      alert('Gagal terhubung ke server spin: ' + e);
    }
  }

  function showWin(amount, mult) {
    // Big Win thresholds
    if (amount >= bet * 200) {
      bigwinEl.textContent = 'MEGA WIN! +' + amount;
      bigwinEl.style.display = 'block';
      bigwinEl.style.transform = 'translateX(-50%) scale(1.08)';
      setTimeout(()=>{ bigwinEl.style.display='none'; bigwinEl.style.transform='translateX(-50%) scale(1)'; }, 2200);
    } else if (amount >= bet * 50) {
      bigwinEl.textContent = 'BIG WIN! +' + amount;
      bigwinEl.style.display = 'block';
      setTimeout(()=>{ bigwinEl.style.display='none'; }, 1600);
    } else {
      // small pop
      const el = document.createElement('div');
      el.textContent = '+ ' + amount;
      el.style.position = 'absolute';
      el.style.left = '50%';
      el.style.top = '12%';
      el.style.transform = 'translateX(-50%)';
      el.style.padding = '8px 12px';
      el.style.borderRadius = '8px';
      el.style.background = 'rgba(255,255,255,0.08)';
      document.body.appendChild(el);
      setTimeout(()=> el.remove(), 900);
    }
    // sound
    if (soundToggle.checked) playWinSound();
  }

  // Basic WebAudio fx
  let audioCtx = null;
  function playBeep(freq, dur=0.05) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type='sine'; o.frequency.value = freq;
    g.gain.value = 0.06;
    o.start(); o.stop(audioCtx.currentTime + dur);
  }
  function playWinSound() {
    playBeep(600, 0.12);
    setTimeout(()=>playBeep(900,0.08), 120);
  }

  // UI events
  spinBtn.addEventListener('click', ()=> { doSpin(); });
  autoBtn.addEventListener('click', ()=> {
    auto = !auto;
    autoBtn.textContent = auto ? 'STOP' : 'AUTO';
    autoBtn.classList.toggle('secondary', !auto);
    if (auto) autoLoop();
  });
  turboBtn.addEventListener('click', ()=> { turbo = !turbo; turboBtn.textContent = turbo ? 'TURBO ✓' : 'TURBO'; turboBtn.classList.toggle('secondary', !turbo); });

  async function autoLoop(){
    while (auto && balance >= bet) {
      await doSpin();
      await new Promise(r => setTimeout(r, Math.max(50, Number(delayInput.value) || 500)));
    }
    auto = false;
    autoBtn.textContent = 'AUTO';
    autoBtn.classList.add('secondary');
  }

  plus.addEventListener('click', ()=> { bet += 10; updateHUD(); });
  minus.addEventListener('click', ()=> { bet = Math.max(1, bet - 10); updateHUD(); });
  betInput.addEventListener('change', ()=> { bet = Math.max(1, Math.floor(Number(betInput.value) || 1)); updateHUD(); });

  // Build UI
  renderPaytable();
  buildStrips();
  updateHUD();

  // keyboard space -> spin
  window.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); doSpin(); }});
})();
</script>
</body>
</html>`;
