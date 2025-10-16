// index.js
// Satpam Bot Berlisensi - Cloudflare Worker (single-file)
// Requires KV binding: env.DB
// TOKEN & ADMIN_IDS must be set below.

const TOKEN = "7819500627:AAGR8QKx4G7J-HMBczMVj3GT3aTBgcBLmlo"; // ganti jika perlu
const ADMIN_IDS = [5560906270]; // admin pusat
const API = `https://api.telegram.org/bot${TOKEN}`;
const QRIS_LINK = "https://raw.githubusercontent.com/Sigitbaberon/qris/refs/heads/main/qr_ID1025423347687_29.09.25_175910930_1759109315016.jpeg";
const LICENSE_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

// anti-duplicate window (seconds)
const DEDUP_TTL = 60;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("bad json", { status: 400 });
    }

    const msg = update.message || update.edited_message;
    if (!msg) return new Response("no message");

    // dedup by chat-message id using KV (prevents loops)
    const dedupKey = `dedup:${msg.chat.id}:${msg.message_id}`;
    if (await env.DB.get(dedupKey)) return new Response("duplicate ignored");
    await env.DB.put(dedupKey, "1", { expirationTtl: DEDUP_TTL });

    try {
      await handleMessage(msg, env);
    } catch (err) {
      console.error("handler error", err);
      for (const aid of ADMIN_IDS) {
        safeSend(aid, `❗ Bot error: ${err.message}`);
      }
    }

    return new Response("ok");
  }
};

// ---------------------- CORE HANDLER ----------------------
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const userId = from.id;
  const username = from.username || "";
  const name = from.first_name || (from.last_name || "");
  const isPrivate = (msg.chat.type === "private");
  const text = (msg.text || "").trim();

  // PRIVATE CHAT: commands, payments, settings
  if (isPrivate) {
    // /start
    if (text === "/start" || text === "/help") {
      await sendMessage(chatId,
        `👋 Halo ${name || "User"}!\n` +
        `Ini adalah *Satpam Bot Berlisensi*.\n` +
        `Untuk menggunakan di grup: bayar lisensi ${LICENSE_DAYS} hari via QRIS lalu kirim bukti (foto).\n\n` +
        `🔗 QRIS: ${QRIS_LINK}\n\n` +
        `Perintah:\n` +
        `/status - lihat status lisensi\n` +
        `/addgroup <chat_id> - daftarkan grup (bot harus admin di grup)\n` +
        `/mygroups - daftar grup yang terdaftar (pemilik lisensi)\n` +
        `Admin only: /pending /approve /reject /licenses`,
        "Markdown"
      );
      await sendPhoto(chatId, QRIS_LINK, "Scan QRIS untuk bayar lisensi.");
      return;
    }

    // PHOTO -> payment proof
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const code = genCode();
      const pending = {
        userId,
        username,
        name,
        fileId: largest.file_id,
        code,
        ts: Date.now()
      };
      await env.DB.put(`pending:${userId}`, JSON.stringify(pending));
      // notify user
      await sendMessage(chatId, `✅ Bukti diterima. Kode verifikasi: \`${code}\`. Tunggu verifikasi admin.`, "Markdown");
      // notify admins
      for (const aid of ADMIN_IDS) {
        await sendMessage(aid,
          `💰 Bukti pembayaran dari [${name}](tg://user?id=${userId})\nKode: \`${code}\`\nGunakan:\n/approve ${userId}  atau /approve ${code}\n/reject ${userId}  atau /reject ${code}`,
          "Markdown"
        );
      }
      return;
    }

    // commands in private chat
    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(" ").trim();

      // admin-only commands
      if (["/pending", "/approve", "/reject", "/licenses"].includes(cmd)) {
        if (!ADMIN_IDS.includes(userId)) {
          await sendMessage(chatId, "❌ Kamu bukan admin!");
          return;
        }
      }

      switch (cmd) {
        case "/pending":
          return await listPending(chatId, env);
        case "/approve":
          return await approveHandler(chatId, env, arg);
        case "/reject":
          return await rejectHandler(chatId, env, arg);
        case "/licenses":
          return await listLicenses(chatId, env);
        case "/status":
          return await statusHandler(chatId, env, userId);
        case "/addgroup":
          return await addGroupCommand(chatId, env, userId, arg);
        case "/mygroups":
          return await myGroups(chatId, env, userId);
        case "/set":
          // /set <group_id> <option> <value>
          return await setCommand(chatId, env, userId, parts);
        default:
          await sendMessage(chatId, "Perintah tidak dikenali. Gunakan /help untuk daftar perintah.");
      }
      return;
    }

    // if plain message in private: ignore or respond
    return;
  }

  // GROUP MESSAGE handling (security)
  // If bot added to group: new_chat_members contains bot or others; handle bot activation
  if (msg.new_chat_members && Array.isArray(msg.new_chat_members)) {
    for (const m of msg.new_chat_members) {
      // if the bot was added to a group (m.is_bot true and m.id == bot id) -> msg.from is inviter
      if (m.is_bot) {
        // When bot is added, msg.from is who added it
        const inviterId = msg.from?.id;
        if (!inviterId) {
          await sendMessage(chatId, "Bot was added but inviter could not be verified.");
          // optionally leave
          return;
        }
        const license = await env.DB.get(`license:${inviterId}`);
        if (!license) {
          await sendMessage(chatId, "❌ Pengundang tidak memiliki lisensi aktif. Bot akan keluar.");
          await leaveGroup(chatId);
          return;
        }
        // register group with owner = inviter
        await env.DB.put(`group:${chatId}`, JSON.stringify({ owner: inviterId, created: Date.now() }));
        // default settings
        const defaultSettings = { antilink: true, antiflood: true, flood_limit: 5, flood_window_seconds: 8, warn_limit: 3 };
        await env.DB.put(`settings:${chatId}`, JSON.stringify(defaultSettings));
        await sendMessage(chatId, `✅ Bot aktif. Pemilik lisensi: [${msg.from.first_name}](tg://user?id=${inviterId})`, "Markdown");
        return;
      } else {
        // normal new member join -> show profile summary and apply checks if group registered
        const groupInfo = await env.DB.get(`group:${chatId}`);
        if (!groupInfo) continue; // not managed
        const settings = JSON.parse(await env.DB.get(`settings:${chatId}`) || "{}");
        const profileCount = await getPhotos(m.id);
        await sendMessage(chatId, `👋 ${m.first_name} bergabung. Foto profil: ${profileCount}`);
        if (profileCount === 0) {
          // warn
          await warningProcess(chatId, m.id, env, settings);
        }
      }
    }
  }

  // If group message and group is registered -> apply security checks
  if (msg.chat.type && (msg.chat.type.endsWith("group") || msg.chat.type === "supergroup")) {
    const groupDataRaw = await env.DB.get(`group:${chatId}`);
    if (!groupDataRaw) return; // not managed group
    const settings = JSON.parse(await env.DB.get(`settings:${chatId}`) || "{}");

    // skip if message is from bot
    if (from.is_bot) return;

    // ANTI-LINK
    if (settings.antilink) {
      if (containsLink(msg)) {
        // delete message & warn
        await deleteMessage(chatId, msg.message_id);
        await sendMessage(chatId, `🚫 ${from.first_name}, link tidak diperbolehkan di grup ini.`);
        await warningProcess(chatId, userId, env, settings);
        return;
      }
    }

    // ANTI-FLOOD
    if (settings.antiflood) {
      const limit = settings.flood_limit || 5;
      const windowSec = settings.flood_window_seconds || 8;
      const tooMany = await floodCheckAndIncrement(chatId, userId, env, windowSec, limit);
      if (tooMany) {
        await sendMessage(chatId, `⚠️ ${from.first_name} terdeteksi flood (${limit} pesan dalam ${windowSec}s).`);
        await warningProcess(chatId, userId, env, settings);
      }
    }
  }
}

// ---------------------- HELPERS & FEATURES ----------------------

// sendMessage wrapper
async function sendMessage(chatId, text, parse_mode = "HTML") {
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("sendMessage err", e);
  }
}

// sendPhoto
async function sendPhoto(chatId, photoUrlOrId, caption = "") {
  try {
    await fetch(`${API}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrlOrId, caption }),
    });
  } catch (e) {
    console.error("sendPhoto err", e);
  }
}

// delete message
async function deleteMessage(chatId, messageId) {
  try {
    await fetch(`${API}/deleteMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch (e) {
    console.error("deleteMessage err", e);
  }
}

// leave group
async function leaveGroup(chatId) {
  try {
    await fetch(`${API}/leaveChat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId }),
    });
  } catch (e) {
    console.error("leaveGroup err", e);
  }
}

// getUserProfilePhotos count
async function getPhotos(userId) {
  try {
    const res = await fetch(`${API}/getUserProfilePhotos?user_id=${userId}&limit=1`);
    const d = await res.json();
    return d.ok ? (d.result.total_count || 0) : 0;
  } catch {
    return 0;
  }
}

// simple link detection (entities preferred but fallback regex)
function containsLink(msg) {
  if (msg.entities && Array.isArray(msg.entities)) {
    for (const e of msg.entities) {
      if (e.type === "url" || e.type === "text_link") return true;
    }
  }
  const text = msg.text || msg.caption || "";
  return /(https?:\/\/|t\.me\/|telegram\.me|\.com|\.net|\.xyz)/i.test(text);
}

// generate license code
function genCode() {
  return `LS-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// list pending payments (admin)
async function listPending(chatId, env) {
  const list = await env.DB.list({ prefix: "pending:" });
  if (!list.keys || list.keys.length === 0) {
    await sendMessage(chatId, "Tidak ada pembayaran pending.");
    return;
  }
  let out = "📋 Pending pembayaran:\n";
  for (const k of list.keys) {
    const p = JSON.parse(await env.DB.get(k.name));
    out += `User ${p.username || p.userId} — kode ${p.code}\n`;
  }
  await sendMessage(chatId, out);
}

// list licenses (admin)
async function listLicenses(chatId, env) {
  const list = await env.DB.list({ prefix: "license:" });
  if (!list.keys || list.keys.length === 0) {
    await sendMessage(chatId, "Belum ada lisensi aktif.");
    return;
  }
  let out = "💼 Lisensi aktif:\n";
  for (const k of list.keys) {
    const L = JSON.parse(await env.DB.get(k.name));
    const uid = k.name.replace("license:", "");
    out += `User ${uid} — sampai ${formatDate(L.exp)} — kode ${L.code}\n`;
  }
  await sendMessage(chatId, out);
}

// approve handler (admin) - arg can be userId or code
async function approveHandler(chatId, env, arg) {
  if (!arg) return await sendMessage(chatId, "Gunakan: /approve <user_id|kode>");
  arg = arg.trim();
  // try userId
  let data = await env.DB.get(`pending:${arg}`);
  let keyName = `pending:${arg}`;

  if (!data) {
    // search by code
    const list = await env.DB.list({ prefix: "pending:" });
    for (const k of list.keys) {
      const pRaw = await env.DB.get(k.name);
      if (!pRaw) continue;
      const p = JSON.parse(pRaw);
      if (p.code === arg) {
        data = pRaw;
        keyName = k.name;
        break;
      }
    }
  }

  if (!data) return await sendMessage(chatId, "❌ User tidak ada di daftar pending.");

  const p = JSON.parse(data);
  const exp = Date.now() + LICENSE_DAYS * DAY_MS;
  await env.DB.put(`license:${p.userId}`, JSON.stringify({ code: p.code, exp, owner: p.userId }));
  await env.DB.delete(keyName);

  await sendMessage(chatId, `✅ Lisensi disetujui untuk ${p.username || p.userId}.`);
  await sendMessage(p.userId, `✅ Lisensi kamu disetujui!\nKode: \`${p.code}\`\nAktif hingga ${formatDate(exp)}.`, "Markdown");
}

// reject handler (admin)
async function rejectHandler(chatId, env, arg) {
  if (!arg) return await sendMessage(chatId, "Gunakan: /reject <user_id|kode>");
  arg = arg.trim();
  let data = await env.DB.get(`pending:${arg}`);
  let keyName = `pending:${arg}`;

  if (!data) {
    const list = await env.DB.list({ prefix: "pending:" });
    for (const k of list.keys) {
      const pRaw = await env.DB.get(k.name);
      if (!pRaw) continue;
      const p = JSON.parse(pRaw);
      if (p.code === arg) {
        data = pRaw;
        keyName = k.name;
        break;
      }
    }
  }

  if (!data) return await sendMessage(chatId, "❌ User tidak ada di daftar pending.");
  const p = JSON.parse(data);
  await env.DB.delete(keyName);
  await sendMessage(chatId, `❌ Pembayaran ${p.username || p.userId} ditolak.`);
  await sendMessage(p.userId, `❌ Pembayaran kamu ditolak. Silakan hubungi admin.`);
}

// status handler for user
async function statusHandler(chatId, env, userId) {
  const licRaw = await env.DB.get(`license:${userId}`);
  if (!licRaw) {
    await sendMessage(chatId, "Kamu belum punya lisensi aktif.");
    return;
  }
  const L = JSON.parse(licRaw);
  await sendMessage(chatId, `Lisensi: ${L.code}\nAktif sampai: ${formatDate(L.exp)}`);
}

// addgroup command: user can register group manually (bot must be admin in group)
async function addGroupCommand(chatId, env, userId, arg) {
  const licRaw = await env.DB.get(`license:${userId}`);
  if (!licRaw) return await sendMessage(chatId, "Kamu belum punya lisensi aktif.");

  if (!arg) return await sendMessage(chatId, "Gunakan: /addgroup <chat_id>. Cara cepat: forward pesan dari grup ke sini.");

  const gid = arg.trim();
  await env.DB.put(`group:${gid}`, JSON.stringify({ owner: userId, created: Date.now() }));
  // default settings if not exist
  const defaultSettings = { antilink: true, antiflood: true, flood_limit: 5, flood_window_seconds: 8, warn_limit: 3 };
  await env.DB.put(`settings:${gid}`, JSON.stringify(defaultSettings));
  // add group to owner's list
  const ownerGroupsRaw = await env.DB.get(`owner_groups:${userId}`);
  let ownerGroups = ownerGroupsRaw ? JSON.parse(ownerGroupsRaw) : [];
  if (!ownerGroups.includes(gid)) {
    ownerGroups.push(gid);
    await env.DB.put(`owner_groups:${userId}`, JSON.stringify(ownerGroups));
  }
  await sendMessage(chatId, `✅ Grup ${gid} didaftarkan. Pastikan bot sudah menjadi admin di grup tersebut.`);
}

// list groups owned by user
async function myGroups(chatId, env, userId) {
  const raw = await env.DB.get(`owner_groups:${userId}`);
  const arr = raw ? JSON.parse(raw) : [];
  if (arr.length === 0) return await sendMessage(chatId, "Kamu belum mendaftarkan grup.");
  let out = "📁 Grup milikmu:\n";
  for (const g of arr) out += `${g}\n`;
  await sendMessage(chatId, out);
}

// setCommand: /set <group_id> <option> <value>
async function setCommand(chatId, env, userId, parts) {
  // parts: ["/set", "<group_id>", "<option>", "<value>"]
  if (parts.length < 4) return await sendMessage(chatId, "Gunakan: /set <group_id> <option> <value>");
  const gid = parts[1];
  const key = parts[2];
  const value = parts.slice(3).join(" ");

  const gRaw = await env.DB.get(`group:${gid}`);
  if (!gRaw) return await sendMessage(chatId, "Grup tidak terdaftar.");
  const g = JSON.parse(gRaw);
  if (String(g.owner) !== String(userId)) return await sendMessage(chatId, "Hanya pemilik lisensi yang bisa mengatur grup ini.");

  const sRaw = await env.DB.get(`settings:${gid}`);
  const settings = sRaw ? JSON.parse(sRaw) : {};
  // try cast booleans or numbers
  let val;
  if (value === "on" || value === "true") val = true;
  else if (value === "off" || value === "false") val = false;
  else if (!isNaN(Number(value))) val = Number(value);
  else val = value;

  settings[key] = val;
  await env.DB.put(`settings:${gid}`, JSON.stringify(settings));
  await sendMessage(chatId, `✅ Pengaturan ${key} untuk grup ${gid} diubah menjadi ${String(val)}.`);
}

// flood detection & increment, return true if exceeded
async function floodCheckAndIncrement(chatId, userId, env, windowSec, limit) {
  const key = `flood:${chatId}:${userId}`;
  const raw = await env.DB.get(key);
  let entry = raw ? JSON.parse(raw) : { count: 0, ts: Date.now() };
  const now = Date.now();
  if ((now - entry.ts) > (windowSec * 1000)) {
    entry = { count: 1, ts: now };
  } else {
    entry.count += 1;
  }
  await env.DB.put(key, JSON.stringify(entry), { expirationTtl: windowSec + 5 });
  return entry.count > limit;
}

// warning process: increment warns, if >= warn_limit kick
async function warningProcess(chatId, userId, env, settings = {}) {
  const warnLimit = settings.warn_limit || 3;
  const key = `warns:${chatId}:${userId}`;
  const raw = await env.DB.get(key);
  const count = raw ? Number(raw) + 1 : 1;
  await env.DB.put(key, String(count), { expirationTtl: 24 * 3600 }); // 24h reset
  await sendMessage(chatId, `⚠️ Peringatan ${count}/${warnLimit} untuk user (${userId}).`);
  if (count >= warnLimit) {
    // kick user
    try {
      await fetch(`${API}/kickChatMember`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, user_id: userId })
      });
      await sendMessage(chatId, `🚫 User (${userId}) dikeluarkan setelah ${count} peringatan.`);
      await env.DB.delete(key);
    } catch (e) {
      console.error("kick err", e);
      await sendMessage(chatId, `Gagal mengeluarkan user (${userId}).`);
    }
  }
}

// ---------------------- UTILS ----------------------
function formatDate(ts) {
  return new Date(ts).toLocaleString("id-ID");
}

async function safeSend(chatId, text) {
  try { await sendMessage(chatId, text); } catch {}
                                     }
