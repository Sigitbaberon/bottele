// Satpam Bot PRO+Analytics (Robust command parsing + Panel UX)
// KV binding required: env.DB
const TOKEN = "7819500627:AAGR8QKx4G7J-HMBczMVj3GT3aTBgcBLmlo";
const ADMIN_IDS = [5560906270];
const API = `https://api.telegram.org/bot${TOKEN}`;
const QRIS_LINK = "https://raw.githubusercontent.com/Sigitbaberon/qris/refs/heads/main/qr_ID1025423347687_29.09.25_175910930_1759109315016.jpeg";

const LICENSE_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
const DEDUP_TTL = 60;
const DEFAULT_SETTINGS = {
  antilink: true,
  antiflood: true,
  flood_limit: 5,
  flood_window_seconds: 8,
  warn_limit: 3
};

// ---------------- Worker entry ----------------
export default {
  async fetch(req, env) {
    try {
      if (req.method !== "POST") return new Response("✅ Satpam PRO+ aktif");
      const update = await req.json().catch(() => null);
      if (!update) return new Response("bad json", { status: 400 });

      if (update.message) {
        const msg = update.message;
        // dedup by chat+message id to prevent double-processing
        const dedupKey = `dedup:${msg.chat.id}:${msg.message_id}`;
        if (await env.DB.get(dedupKey)) return new Response("dup");
        await env.DB.put(dedupKey, "1", { expirationTtl: DEDUP_TTL });
        await handleMessage(msg, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }

      return new Response("ok");
    } catch (err) {
      console.error("Worker error:", err);
      return new Response("error", { status: 500 });
    }
  }
};

// ---------------- Message handler ----------------
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const isPrivate = msg.chat.type === "private";

  if (isPrivate) return await handlePrivate(msg, env);

  // handle new_chat_members (bot added or user joined)
  if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length) {
    for (const m of msg.new_chat_members) {
      if (m.is_bot) {
        // bot was added to a group
        const inviterId = msg.from?.id;
        if (!inviterId) {
          await sendMessage(chatId, "Bot ditambahkan — inviter tidak terdeteksi.");
          return;
        }
        const lic = await env.DB.get(`license:${inviterId}`);
        if (!lic) {
          await sendMessage(chatId, "Pengundang tidak punya lisensi. Bot keluar.");
          await leaveGroup(chatId);
          return;
        }
        // register group and defaults
        await env.DB.put(`group:${chatId}`, JSON.stringify({ owner: inviterId, created: Date.now() }));
        await env.DB.put(`settings:${chatId}`, JSON.stringify(DEFAULT_SETTINGS));
        // add group to owner's list
        const og = JSON.parse(await env.DB.get(`owner_groups:${inviterId}`) || "[]");
        if (!og.includes(String(chatId))) {
          og.push(String(chatId));
          await env.DB.put(`owner_groups:${inviterId}`, JSON.stringify(og));
        }
        await sendMessage(chatId, `✅ Bot aktif. Pemilik lisensi: [${msg.from.first_name}](tg://user?id=${inviterId})`, "Markdown");
        return;
      } else {
        // normal user joined -> show profile count and maybe warn
        const profileCount = await getPhotos(m.id);
        await sendMessage(chatId, `👋 ${m.first_name} bergabung. Foto profil: ${profileCount}`);
        const groupRaw = await env.DB.get(`group:${chatId}`);
        if (!groupRaw) continue;
        const settings = JSON.parse(await env.DB.get(`settings:${chatId}`) || "{}");
        if (profileCount === 0) await warningSystem(chatId, m.id, env, settings);
      }
    }
  }

  // normal group message handling (only if group is registered)
  if (msg.chat.type && (msg.chat.type.endsWith("group") || msg.chat.type === "supergroup")) {
    const gid = msg.chat.id;
    const groupRaw = await env.DB.get(`group:${gid}`);
    if (!groupRaw) return; // not managed
    const settings = JSON.parse(await env.DB.get(`settings:${gid}`) || "{}");
    if (msg.from?.is_bot) return;

    // antilink
    if (settings.antilink && containsLink(msg)) {
      await deleteMessage(gid, msg.message_id);
      await sendMessage(gid, `🚫 ${msg.from.first_name}, link tidak diperbolehkan.`);
      await warningSystem(gid, msg.from.id, env, settings);
      return;
    }

    // antiflood
    if (settings.antiflood) {
      const tooMany = await floodIncrement(gid, msg.from.id, env, settings);
      if (tooMany) {
        await sendMessage(gid, `⚠️ ${msg.from.first_name} terdeteksi flood.`);
        await warningSystem(gid, msg.from.id, env, settings);
      }
    }
  }
}

// ---------------- Private commands (robust parsing) ----------------
async function handlePrivate(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const raw = (msg.text || "").trim();

  // normalize command: accept /cmd, /cmd@BotUser, and lines with extra spaces
  const normalized = normalizeCommand(raw);
  const cmd = normalized.command; // e.g. "/panel"
  const args = normalized.args;   // array of args

  // help/start
  if (cmd === "/start" || cmd === "/help") {
    await sendPhoto(chatId, QRIS_LINK, "📷 Scan QRIS untuk bayar lisensi 30 hari.");
    return sendMessage(chatId,
      `👋 Halo ${msg.from.first_name}!\n\n` +
      `Perintah pribadi:\n` +
      `/status - lihat status lisensi\n` +
      `/addgroup <chat_id> - daftarkan grup (bot harus admin di grup)\n` +
      `/mygroups - lihat grup yang kamu daftar\n` +
      `/panel <chat_id> - buka panel kontrol (atau /panel tanpa arg untuk daftar)\n\n` +
      `Admin pusat: /pending /approve <id|kode> /reject <id|kode> /licenses`,
      "Markdown"
    );
  }

  // handle photo as payment proof
  if (msg.photo?.length) {
    const file = msg.photo[msg.photo.length - 1];
    const code = genCode();
    await env.DB.put(`pending:${userId}`, JSON.stringify({ userId, fileId: file.file_id, code, ts: Date.now() }));
    await sendMessage(chatId, `✅ Bukti diterima. Kode: \`${code}\`. Tunggu verifikasi admin.`, "Markdown");
    for (const a of ADMIN_IDS) await sendMessage(a, `💰 Bukti baru: [${msg.from.first_name}](tg://user?id=${userId})\nKode: \`${code}\``, "Markdown");
    return;
  }

  // non-command text -> ignore
  if (!cmd) return;

  // admin-only commands guard
  if (["/pending","/approve","/reject","/licenses"].includes(cmd) && !ADMIN_IDS.includes(userId))
    return sendMessage(chatId, "🚫 Kamu bukan admin pusat!");

  // command routing
  switch (cmd) {
    case "/status": return statusHandler(chatId, env, userId);
    case "/addgroup": return addGroupHandler(chatId, env, userId, args[0]);
    case "/mygroups": return myGroups(chatId, env, userId);
    case "/panel": return panelCommand(chatId, env, userId, args);
    case "/pending": return listPending(chatId, env);
    case "/approve": return approveHandler(chatId, env, args[0]);
    case "/reject": return rejectHandler(chatId, env, args[0]);
    case "/licenses": return listLicenses(chatId, env);
    default:
      return sendMessage(chatId, "Perintah tidak dikenal. Gunakan /help");
  }
}

// ---------------- Panel command + UX ----------------
async function panelCommand(chatId, env, args) {
  // if user provided group id -> open panel
  if (args && args[0]) {
    return openPanelHandler(chatId, env, null, args[0]); // user check happens in openPanelHandler
  }
  // else list user's groups and show buttons
  const caller = (await getCallerIdFromChat(chatId)); // chatId == userId in private
  const ownerGroups = JSON.parse(await env.DB.get(`owner_groups:${caller}`) || "[]");
  if (ownerGroups.length === 0) return sendMessage(chatId, "Kamu belum mendaftarkan grup. Gunakan /addgroup <chat_id>");

  const rows = ownerGroups.map(gid => ([{ text: `⚙️ ${gid}`, callback_data: `open:${gid}:none` }]));
  // add refresh
  rows.push([{ text: "🔄 Refresh", callback_data: `refresh_list:${caller}:none` }]);

  await sendMessage(chatId, "📁 Grup milikmu — pilih untuk buka panel:", "HTML", { inline_keyboard: rows });
}

// helper to get user id from private chat (chatId equals user id)
function getCallerIdFromChat(chatId) { return Promise.resolve(String(chatId)); }

// openPanelHandler now accepts userId optional (if null will derive from chat)
async function openPanelHandler(chatId, env, userId, gid) {
  // if userId not passed, chatId is private user -> use chatId
  const caller = userId || String(chatId);
  if (!gid) return sendMessage(chatId, "Gunakan: /panel <group_id>");
  const gRaw = await env.DB.get(`group:${gid}`);
  if (!gRaw) return sendMessage(chatId, "❌ Grup belum terdaftar.");
  const g = JSON.parse(gRaw);
  if (String(g.owner) !== String(caller)) return sendMessage(chatId, "🚫 Kamu bukan pemilik grup ini.");

  const s = JSON.parse(await env.DB.get(`settings:${gid}`) || JSON.stringify(DEFAULT_SETTINGS));
  const markup = { inline_keyboard: makePanelButtons(gid, s) };

  // notify admin log that panel opened (helpful)
  for (const a of ADMIN_IDS) {
    await sendMessage(a, `ℹ️ Panel dibuka oleh ${caller} untuk grup ${gid}`);
  }

  return sendMessage(chatId, makePanelText(gid, s), "HTML", markup);
}

// ---------------- Callback handler (panel interactions + list open) ----------------
async function handleCallback(q, env) {
  // simple safety
  if (!q || !q.data) return;
  const fromId = String(q.from.id);
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;
  const parts = q.data.split(":");
  const action = parts[0];
  const gid = parts[1];
  const key = parts[2];

  // special open list action
  if (action === "open") {
    // open panel for gid
    // reply to user who clicked by opening panel in their private chat (use their id)
    return openPanelHandler(fromId, env, fromId, gid);
  }
  if (action === "refresh_list") {
    // rebuild list for user
    const caller = gid; // here gid contains caller id
    const ownerGroups = JSON.parse(await env.DB.get(`owner_groups:${caller}`) || "[]");
    if (ownerGroups.length === 0) {
      await answerCallback(q.id, "Kamu tidak memiliki grup terdaftar.");
      return;
    }
    const rows = ownerGroups.map(g => ([{ text: `⚙️ ${g}`, callback_data: `open:${g}:none` }]));
    rows.push([{ text: "🔄 Refresh", callback_data: `refresh_list:${caller}:none` }]);
    await editMessage(chatId, msgId, "📁 Grup milikmu — pilih untuk buka panel:", { inline_keyboard: rows });
    await answerCallback(q.id, "Di-refresh");
    return;
  }

  // for panel actions we must verify owner
  const gRaw = await env.DB.get(`group:${gid}`);
  if (!gRaw) {
    await answerCallback(q.id, "Grup tidak terdaftar.");
    return;
  }
  const g = JSON.parse(gRaw);
  if (String(g.owner) !== fromId) {
    await answerCallback(q.id, "Kamu bukan pemilik grup ini.");
    return;
  }

  // load settings
  let s = JSON.parse(await env.DB.get(`settings:${gid}`) || JSON.stringify(DEFAULT_SETTINGS));

  switch (action) {
    case "toggle":
      s[key] = !Boolean(s[key]);
      break;
    case "inc":
      s[key] = (Number(s[key] || 0) + 1);
      break;
    case "dec":
      s[key] = Math.max(0, (Number(s[key] || 0) - 1));
      break;
    case "reset":
      s = { ...DEFAULT_SETTINGS };
      break;
    case "stats":
      // produce a stats message (warns top)
      const warns = await env.DB.list({ prefix: `warns:${gid}:` });
      let arr = [];
      for (const k of warns.keys) {
        const val = Number(await env.DB.get(k.name) || 0);
        const uid = k.name.split(":").pop();
        arr.push({ uid, val });
      }
      arr.sort((a,b)=>b.val-a.val);
      let txt = `📊 Top offenders for ${gid}:\n`;
      if (arr.length === 0) txt += "Tidak ada data peringatan.";
      else arr.slice(0,10).forEach((r,i)=> txt += `${i+1}. ${r.uid} — ${r.val} warn(s)\n`);
      await answerCallback(q.id, "Menampilkan stats");
      await sendMessage(fromId, txt);
      return;
    default:
      await answerCallback(q.id, "Aksi tidak dikenal");
      return;
  }

  // save and update panel
  await env.DB.put(`settings:${gid}`, JSON.stringify(s));
  await answerCallback(q.id, "✅ Disimpan");
  await editMessage(chatId, msgId, makePanelText(gid, s), { inline_keyboard: makePanelButtons(gid, s) });
}

// ---------------- Panel UI helpers ----------------
function makePanelText(gid, s) {
  return `⚙️ <b>Panel Grup:</b> <code>${gid}</code>\n\n` +
    `🔗 Antilink: <b>${s.antilink ? "✅ ON" : "❌ OFF"}</b>\n` +
    `💬 Antiflood: <b>${s.antiflood ? "✅ ON" : "❌ OFF"}</b>\n` +
    `📊 Flood limit: ${s.flood_limit}\n` +
    `⏳ Window: ${s.flood_window_seconds}s\n` +
    `⚠️ Warn limit: ${s.warn_limit}`;
}

function makePanelButtons(gid, s) {
  return [
    [
      { text: `🔗 ${s.antilink ? "Antilink ON ✅" : "Antilink OFF ❌"}`, callback_data: `toggle:${gid}:antilink` },
      { text: `💬 ${s.antiflood ? "Antiflood ON ✅" : "Antiflood OFF ❌"}`, callback_data: `toggle:${gid}:antiflood` }
    ],
    [
      { text: "➕ Flood", callback_data: `inc:${gid}:flood_limit` },
      { text: "➖ Flood", callback_data: `dec:${gid}:flood_limit` },
      { text: "⏱ Window ➕", callback_data: `inc:${gid}:flood_window_seconds` },
      { text: "⏱ Window ➖", callback_data: `dec:${gid}:flood_window_seconds` }
    ],
    [
      { text: "⚠️ Warn ➕", callback_data: `inc:${gid}:warn_limit` },
      { text: "⚠️ Warn ➖", callback_data: `dec:${gid}:warn_limit` },
      { text: "📊 Stats", callback_data: `stats:${gid}:none` },
      { text: "♻️ Reset", callback_data: `reset:${gid}:none` }
    ]
  ];
}

// ---------------- Commands implement (same as before) ----------------
async function addGroupHandler(chatId, env, userId, gid) {
  const lic = await env.DB.get(`license:${userId}`);
  if (!lic) return sendMessage(chatId, "❌ Kamu belum berlisensi.");
  if (!gid) return sendMessage(chatId, "Gunakan: /addgroup <chat_id>");
  await env.DB.put(`group:${gid}`, JSON.stringify({ owner: userId, created: Date.now() }));
  await env.DB.put(`settings:${gid}`, JSON.stringify(DEFAULT_SETTINGS));
  const ownerGroups = JSON.parse(await env.DB.get(`owner_groups:${userId}`) || "[]");
  if (!ownerGroups.includes(String(gid))) { ownerGroups.push(String(gid)); await env.DB.put(`owner_groups:${userId}`, JSON.stringify(ownerGroups)); }
  return sendMessage(chatId, `✅ Grup ${gid} terdaftar. Buka /panel ${gid}`);
}

async function myGroups(chatId, env, userId) {
  const arr = JSON.parse(await env.DB.get(`owner_groups:${userId}`) || "[]");
  if (!arr.length) return sendMessage(chatId, "Kamu belum mendaftarkan grup.");
  return sendMessage(chatId, "📋 Grup milikmu:\n" + arr.map(g => `• ${g}`).join("\n"));
}

async function statusHandler(chatId, env, userId) {
  const licRaw = await env.DB.get(`license:${userId}`);
  if (!licRaw) return sendMessage(chatId, "Lisensi: ❌ Tidak aktif");
  const L = JSON.parse(licRaw);
  return sendMessage(chatId, `Lisensi: ${L.code}\nAktif sampai: ${formatDate(L.exp)}`);
}

// pending/approve/reject/licenses (same logic as before)
async function listPending(chatId, env) {
  const lst = await env.DB.list({ prefix: "pending:" });
  if (!lst.keys || lst.keys.length === 0) return sendMessage(chatId, "Tidak ada pending.");
  let out = "📋 Pending:\n";
  for (const k of lst.keys) { const p = JSON.parse(await env.DB.get(k.name)); out += `• ${p.userId} — ${p.code}\n`; }
  return sendMessage(chatId, out);
}
async function approveHandler(chatId, env, arg) {
  if (!arg) return sendMessage(chatId, "Gunakan: /approve <user_id|kode>");
  let data = await env.DB.get(`pending:${arg}`); let key = `pending:${arg}`;
  if (!data) {
    const list = await env.DB.list({ prefix: "pending:" });
    for (const k of list.keys) { const raw = await env.DB.get(k.name); if (!raw) continue; const p = JSON.parse(raw); if (p.code === arg) { data = raw; key = k.name; break; } }
  }
  if (!data) return sendMessage(chatId, "❌ Tidak ditemukan di pending.");
  const p = JSON.parse(data); const exp = Date.now() + LICENSE_DAYS * DAY_MS;
  await env.DB.put(`license:${p.userId}`, JSON.stringify({ code: p.code, exp, owner: p.userId })); await env.DB.delete(key);
  await sendMessage(chatId, `✅ Approved: ${p.userId}`); await sendMessage(p.userId, `✅ Lisensi aktif sampai ${formatDate(exp)}. Kode: ${p.code}`);
}
async function rejectHandler(chatId, env, arg) {
  if (!arg) return sendMessage(chatId, "Gunakan: /reject <user_id|kode>");
  let data = await env.DB.get(`pending:${arg}`); let key = `pending:${arg}`;
  if (!data) {
    const list = await env.DB.list({ prefix: "pending:" });
    for (const k of list.keys) { const raw = await env.DB.get(k.name); if (!raw) continue; const p = JSON.parse(raw); if (p.code === arg) { data = raw; key = k.name; break; } }
  }
  if (!data) return sendMessage(chatId, "❌ Tidak ditemukan di pending.");
  const p = JSON.parse(data); await env.DB.delete(key);
  await sendMessage(chatId, `❌ Rejected: ${p.userId}`); await sendMessage(p.userId, `❌ Pembayaran ditolak. Hubungi admin.`);
}
async function listLicenses(chatId, env) {
  const lst = await env.DB.list({ prefix: "license:" });
  if (!lst.keys || lst.keys.length === 0) return sendMessage(chatId, "Belum ada lisensi.");
  let out = "💼 Lisensi aktif:\n"; for (const k of lst.keys) { const L = JSON.parse(await env.DB.get(k.name)); const uid = k.name.replace("license:", ""); out += `• ${uid} — sampai ${formatDate(L.exp)} — ${L.code}\n`; }
  return sendMessage(chatId, out);
}

// ---------------- Utilities ----------------
function normalizeCommand(text) {
  // returns { command: "/cmd" or null, args: [] }
  if (!text) return { command: null, args: [] };
  // split by whitespace, remove empty
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { command: null, args: [] };
  // command could be "/cmd" or "/cmd@BotUser"
  const rawCmd = parts[0].toLowerCase();
  const m = rawCmd.match(/^\/[a-z0-9_]+(?:@[a-z0-9_]+)?$/i);
  if (!m) return { command: null, args: [] };
  const cmd = rawCmd.split("@")[0]; // remove bot mention
  const args = parts.slice(1);
  return { command: cmd, args };
}

function containsLink(msg) {
  const t = msg.text || msg.caption || "";
  return /(https?:\/\/|t\.me\/|telegram\.me|\.com|\.net|\.xyz)/i.test(t);
}

function genCode() { return `LS-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`; }
function formatDate(ts) { return new Date(ts).toLocaleString("id-ID"); }

async function floodIncrement(gid, uid, env, s) {
  const key = `flood:${gid}:${uid}`;
  const raw = await env.DB.get(key);
  let obj = raw ? JSON.parse(raw) : { count: 0, ts: Date.now() };
  const now = Date.now();
  const windowSec = s.flood_window_seconds || DEFAULT_SETTINGS.flood_window_seconds;
  const limit = s.flood_limit || DEFAULT_SETTINGS.flood_limit;
  if (now - obj.ts > windowSec * 1000) obj = { count: 1, ts: now };
  else obj.count++;
  await env.DB.put(key, JSON.stringify(obj), { expirationTtl: windowSec + 5 });
  return obj.count > limit;
}

async function warningSystem(gid, uid, env, s) {
  const limit = s.warn_limit || DEFAULT_SETTINGS.warn_limit;
  const key = `warns:${gid}:${uid}`;
  const now = Number(await env.DB.get(key) || 0) + 1;
  await env.DB.put(key, String(now), { expirationTtl: 86400 });
  await sendMessage(gid, `⚠️ User (${uid}) peringatan ${now}/${limit}.`);
  if (now >= limit) {
    try {
      await fetch(`${API}/kickChatMember`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: gid, user_id: uid }) });
      await sendMessage(gid, `🚫 User (${uid}) dikeluarkan setelah ${now} peringatan.`);
      await env.DB.delete(key);
    } catch (e) {
      await sendMessage(gid, `Gagal mengeluarkan user (${uid}).`);
    }
  }
}

// ------------- Telegram API helpers -------------
async function sendMessage(chatId, text, mode = "HTML", reply_markup = null) {
  const body = { chat_id: String(chatId), text, parse_mode: mode, disable_web_page_preview: true };
  if (reply_markup) body.reply_markup =
