// Satpam Bot PRO+Analytics (Revised & Optimized Version)
// Diperbaiki untuk stabilitas, efisiensi, dan logika panel yang lebih akurat
// KV Binding diperlukan: env.DB

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

export default {
  async fetch(req, env) {
    try {
      if (req.method !== "POST") return new Response("✅ Satpam PRO+ Aktif");
      const update = await req.json().catch(() => null);
      if (!update) return new Response("Invalid JSON", { status: 400 });

      if (update.message) {
        const msg = update.message;
        const dedupKey = `dedup:${msg.chat.id}:${msg.message_id}`;
        if (await env.DB.get(dedupKey)) return new Response("Duplicate ignored");
        await env.DB.put(dedupKey, "1", { expirationTtl: DEDUP_TTL });
        await handleMessage(msg, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }

      return new Response("ok");
    } catch (err) {
      console.error("Worker Error:", err);
      return new Response("Error: " + err.message, { status: 500 });
    }
  }
};

// ---------------- MESSAGE HANDLER ----------------
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();

  if (msg.chat.type === "private") return await handlePrivate(msg, env);

  // grup event
  if (msg.new_chat_members?.length) {
    for (const m of msg.new_chat_members) {
      if (m.is_bot) {
        const inviterId = msg.from?.id;
        if (!inviterId) return sendMessage(chatId, "❌ Tidak bisa verifikasi pengundang.");

        const lic = await env.DB.get(`license:${inviterId}`);
        if (!lic) {
          await sendMessage(chatId, "🚫 Pengundang tidak memiliki lisensi. Bot keluar.");
          await leaveGroup(chatId);
          return;
        }

        await env.DB.put(`group:${chatId}`, JSON.stringify({ owner: inviterId, created: Date.now() }));
        await env.DB.put(`settings:${chatId}`, JSON.stringify(DEFAULT_SETTINGS));

        const ownerGroups = JSON.parse(await env.DB.get(`owner_groups:${inviterId}`) || "[]");
        if (!ownerGroups.includes(String(chatId))) {
          ownerGroups.push(String(chatId));
          await env.DB.put(`owner_groups:${inviterId}`, JSON.stringify(ownerGroups));
        }

        await sendMessage(chatId, `✅ Bot aktif.\nPemilik: [${msg.from.first_name}](tg://user?id=${inviterId})`, "Markdown");
        return;
      }
    }
  }

  // grup text handler
  if (msg.chat.type.endsWith("group")) {
    const settingsRaw = await env.DB.get(`settings:${chatId}`);
    if (!settingsRaw) return;
    const settings = JSON.parse(settingsRaw);

    if (msg.from.is_bot) return;

    if (settings.antilink && containsLink(msg)) {
      await deleteMessage(chatId, msg.message_id);
      await sendMessage(chatId, `🚫 ${msg.from.first_name}, link tidak diperbolehkan.`);
      await warningSystem(chatId, msg.from.id, env, settings);
      return;
    }

    if (settings.antiflood) {
      const tooFast = await floodIncrement(chatId, msg.from.id, env, settings);
      if (tooFast) {
        await sendMessage(chatId, `⚠️ ${msg.from.first_name}, terlalu sering mengirim pesan!`);
        await warningSystem(chatId, msg.from.id, env, settings);
      }
    }
  }
}

// ---------------- PRIVATE COMMANDS ----------------
async function handlePrivate(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/help") {
    await sendPhoto(chatId, QRIS_LINK, "📷 Scan QRIS untuk bayar lisensi 30 hari.");
    return sendMessage(chatId, `👋 Hai ${msg.from.first_name}!\n\nPerintah:\n/status\n/addgroup <id>\n/mygroups\n/panel <id>\n\nAdmin:\n/pending\n/approve <user_id|kode>\n/reject <user_id|kode>\n/licenses`);
  }

  if (msg.photo?.length) {
    const file = msg.photo[msg.photo.length - 1];
    const code = genCode();
    await env.DB.put(`pending:${userId}`, JSON.stringify({ userId, fileId: file.file_id, code, ts: Date.now() }));
    await sendMessage(chatId, `✅ Bukti diterima.\nKode: \`${code}\`\nTunggu verifikasi admin.`, "Markdown");
    for (const admin of ADMIN_IDS) {
      await sendMessage(admin, `💰 Bukti baru dari [${msg.from.first_name}](tg://user?id=${userId})\nKode: \`${code}\``, "Markdown");
    }
    return;
  }

  if (!text.startsWith("/")) return;

  const [cmd, arg] = text.split(" ");
  if (["/pending", "/approve", "/reject", "/licenses"].includes(cmd) && !ADMIN_IDS.includes(userId))
    return sendMessage(chatId, "🚫 Kamu bukan admin pusat!");

  switch (cmd) {
    case "/status": return statusHandler(chatId, env, userId);
    case "/addgroup": return addGroupHandler(chatId, env, userId, arg);
    case "/mygroups": return myGroups(chatId, env, userId);
    case "/panel": return openPanelHandler(chatId, env, userId, arg);
    case "/pending": return listPending(chatId, env);
    case "/approve": return approveHandler(chatId, env, arg);
    case "/reject": return rejectHandler(chatId, env, arg);
    case "/licenses": return listLicenses(chatId, env);
    default: return sendMessage(chatId, "❌ Perintah tidak dikenal. Gunakan /help");
  }
}

// ---------------- PANEL ----------------
async function openPanelHandler(chatId, env, userId, gid) {
  if (!gid) return sendMessage(chatId, "Gunakan: /panel <group_id>");
  const groupData = await env.DB.get(`group:${gid}`);
  if (!groupData) return sendMessage(chatId, "❌ Grup belum terdaftar.");
  const group = JSON.parse(groupData);
  if (String(group.owner) !== String(userId)) return sendMessage(chatId, "🚫 Kamu bukan pemilik grup ini.");
  const settings = JSON.parse(await env.DB.get(`settings:${gid}`) || JSON.stringify(DEFAULT_SETTINGS));

  const markup = { inline_keyboard: makePanelButtons(gid, settings) };
  return sendMessage(chatId, makePanelText(gid, settings), "HTML", markup);
}

async function handleCallback(q, env) {
  const [action, gid, key] = q.data.split(":");
  const fromId = q.from.id;
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;

  const gRaw = await env.DB.get(`group:${gid}`);
  if (!gRaw) return sendMessage(chatId, "❌ Grup tidak ditemukan.");
  const g = JSON.parse(gRaw);
  if (String(g.owner) !== String(fromId)) return sendMessage(chatId, "🚫 Kamu bukan pemilik grup ini.");

  let s = JSON.parse(await env.DB.get(`settings:${gid}`) || JSON.stringify(DEFAULT_SETTINGS));

  const modify = () => editMessage(chatId, msgId, makePanelText(gid, s), { inline_keyboard: makePanelButtons(gid, s) });

  switch (action) {
    case "toggle":
      s[key] = !s[key];
      break;
    case "inc":
      s[key] = (Number(s[key]) || 0) + 1;
      break;
    case "dec":
      s[key] = Math.max(0, (Number(s[key]) || 0) - 1);
      break;
    case "reset":
      s = { ...DEFAULT_SETTINGS };
      break;
    default:
      return answerCallback(q.id, "Aksi tidak dikenal");
  }

  await env.DB.put(`settings:${gid}`, JSON.stringify(s));
  await answerCallback(q.id, "✅ Diperbarui");
  await modify();
}

// ---------------- HELPERS ----------------
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
      { text: `🔗 Antilink ${s.antilink ? "✅" : "❌"}`, callback_data: `toggle:${gid}:antilink` },
      { text: `💬 Antiflood ${s.antiflood ? "✅" : "❌"}`, callback_data: `toggle:${gid}:antiflood` }
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
      { text: "♻️ Reset", callback_data: `reset:${gid}:none` }
    ]
  ];
}

// ---------------- UTILITIES ----------------
function containsLink(msg) {
  const t = msg.text || msg.caption || "";
  return /(https?:\/\/|t\.me|telegram\.me|\.com|\.net|\.xyz)/i.test(t);
}

function genCode() {
  return `LS-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("id-ID");
}

async function floodIncrement(gid, uid, env, settings) {
  const key = `flood:${gid}:${uid}`;
  const raw = await env.DB.get(key);
  let obj = raw ? JSON.parse(raw) : { count: 0, ts: Date.now() };
  const now = Date.now();
  if (now - obj.ts > (settings.flood_window_seconds * 1000)) obj = { count: 1, ts: now };
  else obj.count++;
  await env.DB.put(key, JSON.stringify(obj), { expirationTtl: settings.flood_window_seconds + 5 });
  return obj.count > settings.flood_limit;
}

// Telegram API helper
async function sendMessage(chatId, text, mode = "HTML", markup = null) {
  const body = { chat_id: chatId, text, parse_mode: mode, disable_web_page_preview: true };
  if (markup) body.reply_markup = markup;
  await fetch(`${API}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function sendPhoto(chatId, url, caption = "") {
  await fetch(`${API}/sendPhoto`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: url, caption })
  });
}

async function editMessage(chatId, msgId, text, markup = null) {
  const body = { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML" };
  if (markup) body.reply_markup = markup;
  await fetch(`${API}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function answerCallback(id, text) {
  await fetch(`${API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text })
  });
}

async function deleteMessage(chatId, msgId) {
  await fetch(`${API}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: msgId })
  });
}

async function leaveGroup(chatId) {
  await fetch(`${API}/leaveChat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId })
  });
}

async function warningSystem(gid, uid, env, s) {
  const limit = s.warn_limit;
  const key = `warns:${gid}:${uid}`;
  const now = Number(await env.DB.get(key) || 0) + 1;
  await env.DB.put(key, now.toString(), { expirationTtl: 86400 });
  await sendMessage(gid, `⚠️ User (${uid}) peringatan ${now}/${limit}.`);
  if (now >= limit) {
    await fetch(`${API}/kickChatMember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: gid, user_id: uid })
    });
    await sendMessage(gid, `🚫 User (${uid}) dikeluarkan setelah ${now} peringatan.`);
    await env.DB.delete(key);
  }
                       }
