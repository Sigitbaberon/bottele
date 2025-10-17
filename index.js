/* File: worker.js  (Module Cloudflare Worker) Purpose: Edge Probe UI + safe probe executor for YOUR OWN targets.

Included in this single file also is an example wrangler.toml (see bottom comment).

BINDINGS expected (configure via wrangler.toml / dashboard):

KV Namespace: LOG_KV

Durable Object: COORDINATOR (class CoordinatorDO)

Environment variables / secrets:

TARGET_ORIGIN (required, e.g. "example.com")

SECRET_HMAC (optional, set with wrangler secret put SECRET_HMAC)

LOG_ENDPOINT (optional webhook for forwarding logs)

SCHEDULE_TARGETS (optional, comma-separated targets)



IMPORTANT: This Worker performs HTTP GET probes only. Use only for content you own or have permission to test. */

// === Configuration / defaults === const DEFAULT_UAS = [ "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 Safari/605.1.15", ];

const HTML_TEMPLATE = (statusMsg = "", lastResult = null) => `<!doctype html>

<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Edge Probe — Form</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.4;margin:0;padding:24px;background:#f6f8fb;color:#0b1224}
    .card{max-width:780px;margin:24px auto;padding:20px;border-radius:12px;background:white;box-shadow:0 6px 24px rgba(12,24,48,0.06)}
    h1{margin:0 0 12px;font-size:20px}
    form{display:flex;gap:8px;flex-wrap:wrap}
    input[type="url"]{flex:1;padding:10px;border-radius:8px;border:1px solid #e6e8ee}
    button{padding:10px 14px;border-radius:8px;border:0;background:#2563eb;color:white;font-weight:600}
    .small{font-size:13px;color:#525f7a;margin-top:8px}
    pre{background:#0b1224;color:#e6eef8;padding:12px;border-radius:8px;overflow:auto}
    .muted{color:#94a3b8;font-size:13px}
  </style>
</head>
<body>
  <div class="card">
    <h1>Edge Probe — Test URL (untuk konten milik Anda)</h1>
    <p class="small">Masukkan URL halaman yang Anda miliki untuk diuji. Worker ini hanya melakukan HTTP probe (GET) dan menyimpan ringkasan hasil ke KV / webhook (opsional).</p><form id="probeForm" method="POST" action="/submit">
  <input type="url" name="target" placeholder="https://example.com/your-page" required />
  <button type="submit">Run Probe</button>
</form>

<div class="small">Status: ${statusMsg || "ready"}</div>
${ lastResult ? `<h3>Last result</h3><pre>${JSON.stringify(lastResult, null, 2)}</pre>` : "" }
<hr/>
<div class="small">Catatan: Worker menjalankan probe dengan random User-Agent dan menyimpan ringkasan. Pastikan TARGET_ORIGIN diset agar hanya domain Anda yang diizinkan.</div>

  </div>
</body>
</html>`;// === Utility helpers === function rand(arr) { return arr[Math.floor(Math.random()*arr.length)]; } function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function signPayload(payloadJson, secret) { if (!secret) return null; const encoder = new TextEncoder(); const keyData = encoder.encode(secret); const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadJson)); return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join(""); }

// === Core probe routine === async function doProbe(targetUrl, env) { const start = Date.now(); const ua = rand(DEFAULT_UAS); const headers = { "User-Agent": ua, "Accept-Language": rand(["en-US,en;q=0.9","id-ID,id;q=0.9"]), "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,/;q=0.8", "X-Edge-Hint": ${env.CF_REGION || "edge"}-${Math.random().toString(36).slice(2,6)}, };

const maxAttempts = 3; let attempt = 0; let res = null; let err = null; let timing = {};

while (attempt < maxAttempts) { attempt++; const t0 = Date.now(); try { res = await fetch(targetUrl, { method: "GET", headers, redirect: "follow" }); const t1 = Date.now(); timing = { start: t0, finish: t1, latency: t1 - t0, attempt }; if (res.status >= 200 && res.status < 400) break; await sleep(200 * Math.pow(2, attempt)); } catch (e) { err = String(e); await sleep(200 * Math.pow(2, attempt)); } }

const end = Date.now(); const summary = { ts: (new Date()).toISOString(), target: targetUrl, status: res ? res.status : null, ok: res ? (res.status >= 200 && res.status < 400) : false, attempt, timing, durationTotalMs: end - start, edgeLocation: env.CF_REGION || env.CF_POD || "edge", ua, error: err, };

if (res && res.headers) { summary.headers = { "content-type": res.headers.get("content-type"), "server": res.headers.get("server"), "cache-control": res.headers.get("cache-control"), }; }

// sign + store to KV + optional webhook try { const key = log:${Date.now()}:${Math.random().toString(36).slice(2,6)}; const payloadJson = JSON.stringify(summary); if (env.SECRET_HMAC) { const signature = await signPayload(payloadJson, env.SECRET_HMAC); summary._sig = signature; } if (env.LOG_KV) { await env.LOG_KV.put(key, JSON.stringify(summary), { expirationTtl: 6060247 }); } if (env.LOG_ENDPOINT) { // best-effort forward (do not forward HTML content) await fetch(env.LOG_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "edge-probe", payload: summary }) }).catch(()=>{/ ignore webhook errors */}); } } catch (e) { summary.kv_error = String(e); }

return summary; }

// === Worker export === export default { async fetch(request, env, ctx) { const url = new URL(request.url); const pathname = url.pathname;

// Health
if (pathname === "/_health") return new Response("ok", { status: 200 });

// Root UI
if (pathname === "/" && request.method === "GET") {
  return new Response(HTML_TEMPLATE("ready", null), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Submit form handler
if (pathname === "/submit" && request.method === "POST") {
  const ct = request.headers.get("Content-Type") || "";
  let formTarget = null;
  if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    formTarget = form.get("target");
  } else {
    try {
      const j = await request.json().catch(()=>null);
      formTarget = j && j.target;
    } catch(e){}
  }

  if (!formTarget) {
    return new Response(HTML_TEMPLATE("Missing target URL", null), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // validate URL and enforce TARGET_ORIGIN if set
  let parsed;
  try { parsed = new URL(formTarget); } catch (e) {
    return new Response(HTML_TEMPLATE("Invalid URL format", null), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (env.TARGET_ORIGIN) {
    if (!parsed.host.endsWith(env.TARGET_ORIGIN)) {
      return new Response(HTML_TEMPLATE("Target not allowed by TARGET_ORIGIN configuration", null), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
  }

  // Ask Coordinator for permission to avoid floods
  try {
    const coordinatorId = env.COORDINATOR.idFromName("global-coordinator");
    const coordinator = env.COORDINATOR.get(coordinatorId);
    const allowResp = await coordinator.fetch("/allow", {
      method: "POST",
      body: JSON.stringify({ op: "manual-submit" })
    });
    if (allowResp.status !== 200) {
      return new Response(HTML_TEMPLATE("Coordinator denied run; try later", null), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
  } catch (e) {
    return new Response(HTML_TEMPLATE("Coordinator error", null), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Schedule background probe and return immediate response
  ctx.waitUntil((async () => {
    await doProbe(formTarget, env);
  })());

  return new Response(HTML_TEMPLATE("Probe scheduled — check logs (KV/webhook) for results", null), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Manual run API (JSON) - for advanced users
if (pathname === "/api/run" && (request.method === "POST" || request.method === "PUT")) {
  try {
    const payload = await request.json();
    const target = payload && payload.target;
    if (!target) return new Response(JSON.stringify({ error: 'missing target' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (env.TARGET_ORIGIN) {
      const host = new URL(target).host;
      if (!host.endsWith(env.TARGET_ORIGIN)) return new Response(JSON.stringify({ error: 'target not allowed' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    // Coordinator check
    const coordinatorId = env.COORDINATOR.idFromName("global-coordinator");
    const coordinator = env.COORDINATOR.get(coordinatorId);
    const allowResp = await coordinator.fetch("/allow", { method: 'POST', body: JSON.stringify({ op: 'api-run' }) });
    if (allowResp.status !== 200) return new Response(JSON.stringify({ error: 'coordinator denied' }), { status: 429, headers: { 'Content-Type': 'application/json' } });

    // Run probe async and return immediately
    ctx.waitUntil(doProbe(target, env));
    return new Response(JSON.stringify({ status: 'scheduled' }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

return new Response('Not found', { status: 404 });

},

// Scheduled cron trigger: runs on many edges, coordinator will gate global throughput async scheduled(controller, env, ctx) { const tasks = env.SCHEDULE_TARGETS ? env.SCHEDULE_TARGETS.split(',').map(s => s.trim()).filter(Boolean) : []; if (tasks.length === 0 && env.TARGET_ORIGIN) tasks.push(https://${env.TARGET_ORIGIN}/); if (tasks.length === 0) return;

// Coordinator ask
try {
  const coordinatorId = env.COORDINATOR.idFromName("global-coordinator");
  const coordinator = env.COORDINATOR.get(coordinatorId);
  const allowResp = await coordinator.fetch("/allow", { method: "POST", body: JSON.stringify({ op: "cron", edgesite: env.CF_POD ? env.CF_POD : "edge" }) });
  if (allowResp.status !== 200) return; // denied
} catch (e) {
  return; // coordinator error
}

for (const target of tasks) {
  const jitter = Math.floor(Math.random() * 800) + 200;
  await sleep(jitter);
  ctx.waitUntil(doProbe(target, env));
}

} };

// === Durable Object Coordinator === export class CoordinatorDO { constructor(state, env) { this.state = state; this.env = env; this.metaKey = 'meta'; }

async fetch(req) { const url = new URL(req.url); if (url.pathname === '/allow') { try { const body = await req.json().catch(()=>({})); const now = Date.now(); const metaRaw = await this.state.get(this.metaKey) || '{}'; const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw; const windowMs = 60 * 1000; // 1 minute window const limitPerWindow = 200; // conservative global threshold meta.calls = (meta.calls || []).filter(t => (now - t) < windowMs); if (meta.calls.length >= limitPerWindow) { await this.state.put(this.metaKey, JSON.stringify(meta)); return new Response(JSON.stringify({ ok:false, reason: 'limit' }), { status: 429, headers: { 'Content-Type': 'application/json' } }); } meta.calls.push(now); await this.state.put(this.metaKey, JSON.stringify(meta)); return new Response(JSON.stringify({ ok:true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } catch (e) { return new Response('error', { status: 500 }); } } return new Response('not found', { status: 404 }); } }

/* Example wrangler.toml (paste to your project root and fill IDs/secrets):

name = "edge-probe-ui" main = "index.js" compatibility_date = "2025-10-17"

[[durable_objects]] name = "COORDINATOR" class_name = "CoordinatorDO"

[[kv_namespaces]] binding = "LOG_KV" id = "<YOUR_KV_NAMESPACE_ID>"

[vars] TARGET_ORIGIN = "shope.com" SCHEDULE_TARGETS = "https://yourdomain.com/video1,https://yourdomain.com/video2" LOG_ENDPOINT = "" # optional webhook

SECRET_HMAC should be set with wrangler secret put SECRET_HMAC "your-secret"

[[triggers]] crons = ["*/5 * * * *"]

Notes:

Replace <YOUR_KV_NAMESPACE_ID> with the KV namespace id from Cloudflare dashboard.

Use wrangler secret put SECRET_HMAC to store SECRET_HMAC securely.

Deploy with wrangler publish. */


  
