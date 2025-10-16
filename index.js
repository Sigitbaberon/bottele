/**
 * Worker: Multi-Game API Proxy / Aggregator
 * Mendukung FreeToGame + RAWG
 *
 * Buat KV bindings:
 *   GAMES_KV (nama KV), binding ke Worker
 */

const FREETOGAME_BASE = "https://www.freetogame.com/api";
const RAWG_BASE = "https://api.rawg.io/api";
const RAWG_KEY = "YOUR_RAWG_API_KEY";  // kalau RAWG butuh key

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Route untuk FreeToGame
  if (path === "/api/ftg/games") {
    return ftgListGames();
  }
  if (path.startsWith("/api/ftg/game/")) {
    const id = path.split("/api/ftg/game/")[1];
    return ftgGameDetail(id);
  }

  // Route untuk RAWG
  if (path === "/api/rawg/games") {
    // dapat query param search: ?search=keyword
    const q = url.searchParams.get("search") || "";
    return rawgSearchGames(q);
  }
  if (path.startsWith("/api/rawg/game/")) {
    const id = path.split("/api/rawg/game/")[1];
    return rawgGameDetail(id);
  }

  // Default: info halaman
  return new Response(`
    <html>
      <body>
        <h2>Multi Game API Worker</h2>
        <ul>
          <li>/api/ftg/games — daftar FreeToGame</li>
          <li>/api/ftg/game/:id — detail FreeToGame</li>
          <li>/api/rawg/games?search=xxx — cari game RAWG</li>
          <li>/api/rawg/game/:id — detail RAWG</li>
        </ul>
      </body>
    </html>`, {
    headers: { "Content-Type": "text/html; charset=UTF-8" }
  });
}

/** ========== FreeToGame ========== */
async function ftgListGames() {
  const cacheKey = "ftg-games";
  const cached = await GAMES_KV.get(cacheKey);
  if (cached) return json(JSON.parse(cached));

  const resp = await fetch(`${FREETOGAME_BASE}/games`);
  if (!resp.ok) return json({ error: "FTG fetch failed" }, 502);
  const data = await resp.json();
  await GAMES_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
  return json(data);
}

async function ftgGameDetail(id) {
  const cacheKey = `ftg-game-${id}`;
  const cached = await GAMES_KV.get(cacheKey);
  if (cached) return json(JSON.parse(cached));

  const resp = await fetch(`${FREETOGAME_BASE}/game?id=${id}`);
  if (!resp.ok) return json({ error: "FTG detail fetch failed" }, 502);
  const data = await resp.json();
  await GAMES_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
  return json(data);
}

/** ========== RAWG ========== */
async function rawgSearchGames(query) {
  const cacheKey = `rawg-search-${query}`;
  const cached = await GAMES_KV.get(cacheKey);
  if (cached) return json(JSON.parse(cached));

  const url = `${RAWG_BASE}/games?key=${RAWG_KEY}&search=${encodeURIComponent(query)}`;
  const resp = await fetch(url);
  if (!resp.ok) return json({ error: "RAWG search failed" }, 502);
  const data = await resp.json();
  await GAMES_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 });
  return json(data);
}

async function rawgGameDetail(id) {
  const cacheKey = `rawg-detail-${id}`;
  const cached = await GAMES_KV.get(cacheKey);
  if (cached) return json(JSON.parse(cached));

  const url = `${RAWG_BASE}/games/${id}?key=${RAWG_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) return json({ error: "RAWG detail failed" }, 502);
  const data = await resp.json();
  await GAMES_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 });
  return json(data);
}

// Helper: JSON response
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" }
  });
}
