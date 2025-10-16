// Satpam Bot PRO+Analytics - Cloudflare Worker (single-file)
// KV binding required: env.DB

const TOKEN = "7819500627:AAGR8QKx4G7J-HMBczMVj3GT3aTBgcBLmlo";
const ADMIN_IDS = [5560906270];
const API = `https://api.telegram.org/bot${TOKEN}`;
const QRIS_LINK = "https://raw.githubusercontent.com/Sigitbaberon/qris/refs/heads/main/qr_ID1025423347687_29.09.25_175910930_1759109315016.jpeg";
const LICENSE_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
const DEDUP_TTL = 60;
const DEFAULT_SETTINGS = { antilink: true, antiflood: true, flood_limit: 5, flood_window_seconds: 8, warn_limit: 3 };

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("✅ Satpam PRO+ aktif");
    const update = await req.json().catch(() => null);
    if (!update) return new Response("bad json", { status: 400 });

    // message or callback query
    if (update.message) {
      const msg = update.message;
      // dedup
      const dedupKey = `dedup:${msg.chat.id}:${msg.message_id}`;
      if (await env.DB.get(dedupKey)) return new Response("dup");
      await env.DB.put(dedupKey, "1", { expirationTtl: DEDUP_TTL });
      await handleMessage(msg, env);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query, env);
    }
    return new Response("ok");
  }
};

// --------------------- MESSAGE HANDLER ---------------------
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const userId = from.id;
  const text = (msg.text || "").trim();
  const isPrivate = msg.chat.type === "private";

  if (isPrivate) return await handlePrivate(msg, env);

  // GROUP
  if (msg.new_chat_members && Array.isArray(msg.new_chat_members)) {
    // do welcome checks
    for (const m of msg.new_chat_members) {
      if (m.is_bot) {
        // bot added - validate inviter
        const inviterId = msg.from?.id;
        if (!inviterId) { await sendMessage(chatId, "Bot ditambahkan, inviter tidak dapat diverifikasi."); return; }
        const lic = await env.DB.get(`license:${inviterId}`);
        if (!lic) { await sendMessage(chatId, "Pengundang tidak punya lisensi. Bot keluar."); await leaveGroup(chatId); return; }
        // register group
        await env.DB.put(`group:${chatId}`, JSON.stringify({ owner: inviterId, created: Date.now() }));
        await env.DB.put(`settings:${chatId}`, JSON.stringify(DEFAULT_SETTINGS));
        // add to owner groups
        const og = JSON.parse(await env.DB.get(`owner_groups:${inviterId}`) || "[]");
        if (!og.includes(String(chatId))) { og.push(String(chatId)); await env.DB.put(`owner_groups:${inviterId}`, JSON.stringify(og)); }
        await sendMessage(chatId, `✅ Bot aktif. Pemilik lisensi: [${msg.from.first_name}](tg://user?id=${inviterId})`, "Markdown");
        return;
      } else {
        // normal user join
        const profileCount = await getPhotos(m.id);
        await sendMessage(chatId, `👋 ${m.first_name} bergabung. Foto profil: ${profileCount}`);
        const groupRaw = await env.DB.get(`group:${chatId}`);
        if (!groupRaw) continue;
        const settings = JSON.parse(await env.DB.get(`settings:${chatId}`) || "{}");
        if (profileCount === 0) await warningProcess(chatId, m.id, env, settings);
      }
    }
  }

  // normal group text handling if group is managed
  if (msg.chat.type && (msg.chat.type.endsWith("group") || msg.chat.type === "supergroup")) {
    const gid = msg.chat.id;
    const groupData = await env.DB.get(`group:${gid}`);
    if (!groupData) return;
    const settings = JSON.parse(await env.DB.get(`settings:${gid}`) || "{}");
    if (from.is_bot) return;

    if (settings.antilink && containsLink(msg)) {
      await deleteMessage(gid, msg.message_id);
      await sendMessage(gid, `🚫 ${from.first_name}, link tidak diperbolehkan.`);
      await warningSystem(gid, from.id, env, settings);
      return;
    }

    if (settings.antiflood) {
      const tooMany = await floodCheckAndIncrement(gid, from.id, env, settings.flood_window_seconds || 8, settings.flood_limit || 5);
      if (tooMany) {
        await sendMessage(gid, `⚠️ ${from.first_name} mengirim terlalu sering!`);
        await warningSystem(gid, from.id, env, settings);
      }
      return;
    }
  }
}

// --------------------- PRIVATE CMDs ---------------------
async function handlePrivate(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/help") {
    await sendPhoto(chatId, QRIS_LINK, "📷 Scan QRIS untuk bayar lisensi 30 hari.");
    return sendMessage(chatId, `👋 Halo ${msg.from.first_name}!\n\nPerintah:\n/status /addgroup /mygroups /panel <group_id>\nAdmin: /pending /approve /reject /licenses`, "Markdown");
  }

  if (msg.photo && msg.photo.length) {
    const file = msg.photo[msg.photo.length - 1];
    const code = genCode();
    await env.DB.put(`pending:${userId}`, JSON.stringify({ userId, fileId: file.file_id, code, ts: Date.now() }));
    await sendMessage(chatId, `✅ Bukti diterima. Kode: \`${code}\`. Tunggu verifikasi admin.`, "Markdown");
    for (const a of ADMIN_IDS) await sendMessage(a, `💰 Bukti baru: [${msg.from.first_name}](tg://user?id=${userId})\nKode: \`${code}\``, "Markdown");
    return;
  }

  if (!text.startsWith("/")) return;

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1);

  // admin-only check for certain commands
  if (["/pending","/approve","/reject","/licenses"].includes(cmd) && !ADMIN_IDS.includes(userId))
    return sendMessage(chatId, "🚫 Kamu bukan admin pusat!");

  switch (cmd) {
    case "/status": return statusHandler(chatId, env, userId);
    case "/addgroup": return addGroupHandler(chatId, env, userId, arg[0]);
    case "/mygroups": return myGroups(chatId, env, userId);
    case "/panel": return openPanelHandler(chatId, env, userId, arg[0]);
    case "/pending": return listPending(chatId, env);
    case "/approve": return approveHandler(chatId, env, arg[0]);
    case "/reject": return rejectHandler(chatId, env, arg[0]);
    case "/licenses": return listLicenses(chatId, env);
    default: return sendMessage(chatId, "Perintah tidak dikenal. Gunakan /help");
  }
}

// --------------------- PANEL + CALLBACK ---------------------
async function openPanelHandler(chatId, env, userId, gid) {
  if (!gid) return sendMessage(chatId, "Gunakan: /panel <group_id>");
  const gRaw = await env.DB.get(`group:${gid}`);
  if (!gRaw) return sendMessage(chatId, "❌ Grup belum terdaftar.");
  const g = JSON.parse(gRaw);
  if (String(g.owner) !== String(userId)) return sendMessage(chatId, "🚫 Kamu bukan pemilik grup ini.");
  const s = JSON.parse(await env.DB.get(`settings:${gid}`) || JSON.stringify(DEFAULT_SETTINGS));
  return sendMessage(chatId, makePanelText(gid, s), "HTML", JSON.stringify(makePanelButtons(gid, s)));
}

async function handleCallback(q, env) {
  const data = q.data; // format: action:gid:key (e.g. toggle:-100123:antilink) or inc:gid:flood_limit
  const fromId = q.from.id;
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;

  const parts = data.split(":");
  const action = parts[0];
  const gid = parts[1];
  const key = parts[2];

  const gRaw = await env.DB.get(`group:${gid}`);
  if (!gRaw) return sendMessage(chatId, "❌ Grup tidak terdaftar.");
  const g = JSON.parse(gRaw);
  if (String(g.owner) !== String(fromId)) return sendMessage(chatId, "🚫 Kamu bukan pemilik grup ini.");

  let settings = JSON.parse(await env.DB.get(`settings:${gid}`) || JSON.stringify(DEFAULT_SETTINGS));

  switch (action) {
    case "toggle":
      settings[key] = !Boolean(settings[key]);
      await env.DB.put(`settings:${gid}`, JSON.stringify(settings));
      await editMessage(chatId, msgId, makePanelText(gid, settings), JSON.stringify(makePanelButtons(gid, settings)));
      break;

    case "inc":
      settings[key] = (Number(settings[key] || 0) + 1);
      await env.DB.put(`settings:${gid}`, JSON.stringify(settings));
      await editMessage(chatId, msgId, makePanelText(gid, settings), JSON.stringify(makePanelButtons(gid, settings)));
      break;

    case "dec":
      settings[key] = Math.max(0, (Number(settings[key] || 0) - 1));
      await env.DB.put(`settings:${gid}`, JSON.stringify(settings));
      await editMessage(chatId, msgId, makePanelText(gid, settings), JSON.stringify(makePanelButtons(gid, settings)));
      break;

    case "reset":
      settings = Object.assign({}, DEFAULT_SETTINGS);
      await env.DB.put(`settings:${gid}`, JSON.stringify(settings));
      await editMessage(chatId, msgId, makePanelText(gid, settings), JSON.stringify(makePanelButtons(gid, settings)));
      break;

    case "stats":
      // gather top warn offenders for this group
      const warnsList = await env.DB.list({ prefix: `warns:${gid}:` });
      let stats = [];
      for (const k of warnsList.keys) {
        const raw = await env.DB.get(k.name);
        if (!raw) continue;
        const uid = k.name.split(":").pop();
        stats.push({ userId: uid, warns: Number(raw) });
      }
      stats.sort((a,b)=>b.warns-a.warns);
      let text = `📊 Top offenders (group ${gid}):\n`;
      if (stats.length === 0) text += "Tidak ada data peringatan.";
      else stats.slice(0,10).forEach((s,i)=> text += `${i+1}. ${s.userId} — ${s.warns} warn(s)\n`);
      await answerCallback(q.id, "Menampilkan stats...");
      await sendMessage(chatId, text);
      break;

    case "refresh":
      await editMessage(chatId, msgId, makePanelText(gid, settings), JSON.stringify(makePanelButtons(gid, settings)));
      break;

    default:
      await answerCallback(q.id, "Aksi tidak dikenal");
  }
}

// --------------------- HELPERS: PANEL UI ---------------------
function makePanelText(gid, s) {
  return `⚙️ <b>Panel Grup:</b> <code>${gid}</code>\n\n` +
    `🔗 Antilink: <b>${s.antilink ? "✅ ON" : "❌ OFF"}</b>\n` +
    `💬 Antiflood: <b>${s.antiflood ? "✅ ON" : "❌ OFF"}</b>\n` +
    `📊 Flood limit: ${s.flood_limit || DEFAULT_SETTINGS.flood_limit}\n` +
    `⏳ Flood window: ${s.flood_window_seconds || DEFAULT_SETTINGS.flood_window_seconds}s\n` +
    `⚠️ Warn limit: ${s.warn_limit || DEFAULT_SETTINGS.warn_limit}`;
}

function makePanelButtons(gid, s) {
  return [
    [
      { text: `🔗 ${s.antilink ? "Antilink ON ✅" : "Antilink OFF ❌"}`, callback_data: `toggle:${gid}:antilink` },
      { text: `💬 ${s.antiflood ? "Antiflood ON ✅" : "Antiflood OFF ❌"}`, callback_data: `toggle:${gid}:antiflood` }
    ],
    [
      { text: `➕ Flood limit`, callback_data: `inc:${gid}:flood_limit` },
      { text: `➖ Flood limit`, callback_data: `dec:${gid}:flood_limit` },
      { text: `⏱ Window ➕`, callback_data: `inc:${gid}:flood_window_seconds` },
      { text: `⏱ Window ➖`, callback_data: `dec:${gid}:flood_window_seconds` }
    ],
    [
      { text: `⚠️ Warn limit ➕`, callback_data: `inc:${gid}:warn_limit` },
      { text: `⚠️ Warn limit ➖`, callback_data: `dec:${gid}:warn_limit` },
      { text: `🔄 Refresh`, callback_data: `refresh:${gid}:none` }
    ],
    [
      { text: `📊 Show Stats`, callback_data: `stats:${gid}:none` },
      { text: `♻️ Reset to default`, callback_data: `reset:${gid}:none` }
    ]
  ];
}

// --------------------- COMMAND IMPLEMENTATIONS ---------------------
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
  if (arr.length === 0) return sendMessage(chatId, "Kamu belum mendaftarkan grup.");
  return sendMessage(chatId, "📋 Grup milikmu:\n" + arr.map(g=>`• ${g}`).join("\n"));
}

async function statusHandler(chatId, env, userId) {
  const licRaw = await env.DB.get(`license:${userId}`);
  if (!licRaw) return sendMessage(chatId, "Lisensi: ❌ Tidak aktif");
  const L = JSON.parse(licRaw);
  return sendMessage(chatId, `Lisensi: ${L.code}\nAktif sampai: ${formatDate(L.exp)}`);
}

// admin functions (pending/approve/reject/licenses)
async function listPending(chatId, env) {
  const lst = await env.DB.list({ prefix: "pending:" });
  if (!lst.keys || lst.keys.length === 0) return sendMessage(chatId, "Tidak ada pending.");
  let out = "📋 Pending:\n";
  for (const k of lst.keys) {
    const p = JSON.parse(await env.DB.get(k.name));
    out += `• ${p.userId} — ${p.code}\n`;
  }
  return sendMessage(chatId, out);
}
async function approveHandler(chatId, env, arg) {
  if (!arg) return sendMessage(chatId, "Gunakan: /approve <user_id|kode>");
  let data = await env.DB.get(`pending:${arg}`);
  let key = `pending:${arg}`;
  if (!data) {
    const list = await env.DB.list({ prefix: "pending:" });
    for (const k of list.keys) {
      const raw = await env.DB.get(k.name);
      if (!raw) continue;
      const p = JSON.parse(raw);
      if (p.code === arg) { data = raw; key = k.name; break; }
    }
  }
  if (!data) return sendMessage(chatId, "❌ Tidak ditemukan di pending.");
  const p = JSON.parse(data);
  const exp = Date.now() + LICENSE_DAYS*DAY_MS;
  await env.DB.put(`license:${p.userId}`, JSON.stringify({ code: p.code, exp, owner: p.userId }));
  await env.DB.delete(key);
  await sendMessage(chatId, `✅ Approved: ${p.userId}`);
  await sendMessage(p.userId, `✅ Lisensi aktif sampai ${formatDate(exp)}. Kode: ${p.code}`);
}
async function rejectHandler(chatId, env, arg) {
  if (!arg) return sendMessage(chatId, "Gunakan: /reject <user_id|kode>");
  let data = await env.DB.get(`pending:${arg}`);
  let key = `pending:${arg}`;
  if (!data) {
    const list = await env.DB.list({ prefix: "pending:" });
    for (const k of list.keys) {
      const raw = await env.DB.get(k.name);
      if (!raw) continue;
      const p = JSON.parse(raw);
      if (p.code === arg) { data = raw; key = k.name; break; }
    }
  }
  if (!data) return sendMessage(chatId, "❌ Tidak ditemukan di pending.");
  const p = JSON.parse(data);
  await env.DB.delete(key);
  await sendMessage(chatId, `❌ Rejected: ${p.userId}`);
  await sendMessage(p.userId, `❌ Pembayaran ditolak. Hubungi admin.`);
}
async function listLicenses(chatId, env) {
  const lst = await env.DB.list({ prefix: "license:" });
  if (!lst.keys || lst.keys.length === 0) return sendMessage(chatId, "Belum ada lisensi.");
  let out = "💼 Lisensi aktif:\n";
  for (const k of lst.keys) {
    const L = JSON.parse(await env.DB.get(k.name));
    const uid = k.name.replace("license:","");
    out += `• ${uid} — sampai ${formatDate(L.exp)} — ${L.code}\n`;
  }
  return sendMessage(chatId, out);
}

// --------------------- UTILITIES / SAFETY ---------------------
async function sendMessage(chatId, text, mode="HTML", reply_markup=null) {
  const body = { chat_id: chatId, text, parse_mode: mode, disable_web_page_preview: true };
  if (reply_markup) body.reply_markup = reply_markup;
  await fetch(`${API}/sendMessage`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
}
async function editMessage(chatId, msgId, text, reply_markup=null) {
  const body = { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML" };
  if (reply_markup) body.reply_markup = reply_markup;
  await fetch(`${API}/editMessageText`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
}
async function answerCallback(callback_id, text="") {
  await fetch(`${API}/answerCallbackQuery`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ callback_query_id: callback_id, text, show_alert:false }) });
}
async function deleteMessage(chatId, msgId) {
  await fetch(`${API}/deleteMessage`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ chat_id: chatId, message_id: msgId }) });
}
async function leaveGroup(chatId) {
  await fetch(`${API}/leaveChat`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ chat_id: chatId }) });
}
function containsLink(msg) {
  const t = msg.text || msg.caption || "";
  return /(https?:\/\/|t\.me|telegram\.me|\.com|\.net|\.xyz)/i.test(t);
}
function genCode(){ return `LS-${Math.random().toString(36).substring(2,8).toUpperCase()}-${Math.floor(1000+Math.random()*9000)}`; }
function formatDate(ts){ return new Date(ts).toLocaleString("id-ID"); }

// flood incr/check
async function floodCheckAndIncrement(gid, uid, env, windowSec, limit) {
  const key = `flood:${gid}:${uid}`;
  const raw = await env.DB.get(key);
  let obj = raw ? JSON.parse(raw) : { count:0, ts: Date.now() };
  const now = Date.now();
  if (now - obj.ts > windowSec*1000) obj = { count:1, ts: now };
  else obj.count++;
  await env.DB.put(key, JSON.stringify(obj), { expirationTtl: windowSec + 5 });
  return obj.count > limit;
}
async function floodCheck(gid, uid, env, settings) {
  return await floodCheckAndIncrement(gid, uid, env, settings.flood_window_seconds || 8, settings.flood_limit || 5);
}

// warning/kick
async function warningSystem(gid, uid, env, settings) {
  const warnLimit = settings.warn_limit || DEFAULT_SETTINGS.warn_limit;
  const key = `warns:${gid}:${uid}`;
  const current = Number(await env.DB.get(key) || 0) + 1;
  await env.DB.put(key, String(current), { expirationTtl: 86400 });
  await sendMessage(gid, `⚠️ User (${uid}) peringatan ${current}/${warnLimit}.`);
  if (current >= warnLimit) {
    // try kick
    try {
      await fetch(`${API}/kickChatMember`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ chat_id: gid, user_id: uid }) });
      await sendMessage(gid, `🚫 User (${uid}) dikeluarkan setelah ${current} peringatan.`);
      await env.DB.delete(key);
      // notify owner
      const gRaw = await env.DB.get(`group:${gid}`);
      if (gRaw) {
        const g = JSON.parse(gRaw);
        await sendMessage(g.owner, `🚨 User ${uid} dikeluarkan di grup ${gid} setelah ${current} peringatan.`);
      }
    } catch (e) {
      await sendMessage(gid, `Gagal mengeluarkan user (${uid}).`);
    }
  }
}

// duplicate-safe wrapper for flood usage (compat)
async function floodCheckAndIncrement(gid, uid, env, windowSec, limit) {
  return await floodCheckAndIncrement(gid, uid, env, windowSec, limit);
}

// safe getUserProfilePhotos
async function getPhotos(uid) {
  try {
    const res = await fetch(`${API}/getUserProfilePhotos?user_id=${uid}&limit=1`);
    const d = await res.json();
    return d.ok ? (d.result.total_count || 0) : 0;
  } catch { return 0; }
    }
