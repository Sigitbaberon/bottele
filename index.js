// bot-licensed-satpam-30d.js
// Cloudflare Worker - Satpam Bot berlisensi (30-day subscription)
// NOTE: No KV. All storage is in-memory (globalThis). Will be lost on restart/redeploy.
// Recommended: set BOT_TOKEN and ADMIN_ID as secrets in Wrangler (env.BOT_TOKEN, env.ADMIN_ID).

const FALLBACK_TOKEN = "7522192709:AAFDwX-Lng-_3FUtr6oAiFu-nfD_XLMCsd8"; // fallback only (not recommended)
const FALLBACK_ADMIN = 7729648778; // fallback admin id if env not set
const QRIS_LINK = "https://raw.githubusercontent.com/Sigitbaberon/qris/refs/heads/main/qr_ID1025423347687_29.09.25_175910930_1759109315016.jpeg";
const LICENSE_VALID_DAYS = 30;
const MS_IN_DAY = 24 * 3600 * 1000;

export default {
  async fetch(request, env) {
    const TOKEN = env && env.BOT_TOKEN ? env.BOT_TOKEN : FALLBACK_TOKEN;
    const ADMIN_ID = env && env.ADMIN_ID ? parseInt(env.ADMIN_ID) : FALLBACK_ADMIN;
    const API = `https://api.telegram.org/bot${TOKEN}`;

    // init in-memory stores
    if (!globalThis.LIC) {
      globalThis.LIC = {
        PENDING: {},   // userId -> { userId, username, ts, mediaFileId, code }
        LICENSES: {},  // userId -> { code, activeUntil: ts, groups: [chatId...] }
        GROUPS: {},    // chatId -> { ownerUserId }
        SETTINGS: {},  // chatId -> per-group settings
        LOGS: [],      // array of recent logs (in-memory)
      };
    }

    try {
      if (request.method === "POST") {
        const update = await request.json();
        if (update.message) return await handleMessage(update.message, API, ADMIN_ID);
        if (update.callback_query) return new Response("No callbacks handled");
        return new Response("unsupported update");
      } else {
        return new Response("Bot Licenced Satpam (30-day) aktif ✅");
      }
    } catch (e) {
      // log error to admin
      await safeSend(API, ADMIN_ID, `❗Bot error: ${e.message}\n${e.stack || ""}`);
      return new Response("error", { status: 500 });
    }
  },
};

// ------------------ HANDLER ------------------
async function handleMessage(msg, API, ADMIN_ID) {
  const chatId = msg.chat.id;
  const isPrivate = (msg.chat.type === "private");
  const from = msg.from || {};
  const userId = from.id;
  const text = (msg.text || "").trim();

  // === PRIVATE CHAT FLOW: /start, payment, upload proof, manage license ===
  if (isPrivate) {
    // /start -> show QRIS and instructions
    if (text === "/start" || text === "/help") {
      const welcome = `Halo ${from.first_name || ""} 👋\n` +
        `Untuk menggunakan bot Satpam ini di grupmu, diperlukan lisensi ${LICENSE_VALID_DAYS} hari.\n` +
        `Silakan bayar lewat QRIS berikut, lalu kirim bukti transfer (foto) di chat ini.\n\n` +
        `🔗 Link QRIS: ${QRIS_LINK}\n\n` +
        `Setelah mengirim bukti, tunggu admin memverifikasi. Kamu akan mendapat kode lisensi jika disetujui.`;
      await sendMessage(API, chatId, welcome);
      // also show the image (QR)
      await sendPhoto(API, chatId, QRIS_LINK, "QRIS - bayar disini");
      return new Response("ok");
    }

    // User uploads photo (assume it's proof of payment)
    // Telegram sends photos in msg.photo as array (sizes). We'll store file_id of largest.
    if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      // create pending entry
      const code = generateLicenseCode();
      globalThis.LIC.PENDING[userId] = {
        userId,
        username: from.username || null,
        ts: Date.now(),
        mediaFileId: largest.file_id,
        code,
      };
      // notify user
      await sendMessage(API, chatId, `✅ Bukti diterima. Kode verifikasi sementara: <code>${code}</code>\nTunggu verifikasi admin.`);
      // notify admin with approve/reject instructions
      await sendMessage(API, ADMIN_ID,
        `🔔 Pembayaran masuk dari ${from.username ? "@" + from.username : from.first_name + " ("+userId+")"}.\n` +
        `User ID: ${userId}\nKode verifikasi: ${code}\nGunakan perintah:\n` +
        `/approve ${userId}\n` +
        `/reject ${userId}\n` +
        `Lihat bukti: gunakan /getproof ${userId}`);
      // store brief log
      pushLog(`Pending payment from ${userId} (code ${code})`);
      return new Response("ok");
    }

    // If user sends code to activate (they may paste code)
    if (/^LS-[A-Z0-9\-]+$/i.test(text)) {
      const given = text.trim().toUpperCase();
      // find pending or license with same code
      const pending = Object.values(globalThis.LIC.PENDING).find(p => p.code === given);
      if (pending && pending.userId === userId) {
        // not yet approved by admin — inform user to wait
        await sendMessage(API, chatId, `Kode ${given} terdaftar tetapi menunggu verifikasi admin. Silakan tunggu.`);
        return new Response("ok");
      }
      // maybe admin already approved and assigned license with same code
      const licEntry = Object.entries(globalThis.LIC.LICENSES).find(([uid, L]) => L.code === given);
      if (licEntry) {
        const [ownerId, L] = licEntry;
        if (parseInt(ownerId) === userId) {
          await sendMessage(API, chatId, `✅ Lisensi valid. Aktif sampai: ${new Date(L.activeUntil).toLocaleString()}`);
          return new Response("ok");
        } else {
          await sendMessage(API, chatId, `❌ Kode lisensi bukan milik akunmu.`);
          return new Response("ok");
        }
      }
      await sendMessage(API, chatId, `❌ Kode tidak ditemukan. Pastikan kamu mengirim kode yang benar.`);
      return new Response("ok");
    }

    // Commands usable by licensed users in private chat
    // /addgroup -> user wants to register a group (bot must be admin in that group)
    if (text.startsWith("/addgroup")) {
      // format: /addgroup <chat_id>  OR instruct user to forward a message from that group to this bot (then we can get chat id)
      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        await sendMessage(API, chatId, `Gunakan: /addgroup <chat_id>\nAtau forward pesan dari grup ke chat ini agar bot bisa membaca chat_id.`);
        return new Response("ok");
      }
      const targetChatId = parseInt(parts[1]);
      if (!targetChatId) {
        await sendMessage(API, chatId, `ID grup tidak valid.`);
        return new Response("ok");
      }
      // check license
      const lic = globalThis.LIC.LICENSES[userId];
      if (!lic || lic.activeUntil < Date.now()) {
        await sendMessage(API, chatId, `❌ Lisensimu tidak aktif. Silakan bayar/perpanjang.`);
        return new Response("ok");
      }
      // register group under this owner
      globalThis.LIC.GROUPS[targetChatId] = { ownerUserId: userId };
      // also record in license groups
      lic.groups = lic.groups || [];
      if (!lic.groups.includes(targetChatId)) lic.groups.push(targetChatId);
      await sendMessage(API, chatId, `✅ Grup ${targetChatId} didaftarkan. Pastikan bot sudah admin di grup tersebut.`);
      await sendMessage(API, ADMIN_ID, `ℹ️ ${formatUserSimple(from)} menambahkan grup ${targetChatId} ke lisensinya.`);
      return new Response("ok");
    }

    // /status -> show license status
    if (text === "/status") {
      const lic = globalThis.LIC.LICENSES[userId];
      if (!lic) return await sendMessage(API, chatId, `Kamu belum punya lisensi aktif.`);
      await sendMessage(API, chatId, `Lisensi: ${lic.code}\nAktif sampai: ${new Date(lic.activeUntil).toLocaleString()}\nGrup terdaftar: ${lic.groups ? lic.groups.join(", ") : "(tidak ada)"}`);
      return new Response("ok");
    }

    // /renew -> show QRIS again
    if (text === "/renew") {
      await sendMessage(API, chatId, `Untuk perpanjangan lisensi (${LICENSE_VALID_DAYS} hari), silakan bayar lewat QRIS berikut dan kirim bukti:`);
      await sendPhoto(API, chatId, QRIS_LINK, "QRIS perpanjangan");
      return new Response("ok");
    }

    // other private commands for admins (you)
    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      // Admin-only commands (must be ADMIN_ID user)
      if (userId !== ADMIN_ID) {
        // non-admin users other commands handled above; otherwise unauthorized
        // allow small help fallback
        if (cmd === "/help" || cmd === "/commands") {
          await sendMessage(API, chatId, "Perintah private: /start, kirim foto bukti transfer, /status, /addgroup <chat_id>, /renew");
          return new Response("ok");
        }
        return new Response("ok");
      }

      // === Admin actions ===
      if (cmd === "/pending") {
        const pend = Object.values(globalThis.LIC.PENDING);
        if (pend.length === 0) return await sendMessage(API, chatId, "Tidak ada pembayaran pending.");
        let msg = "Pending payments:\n";
        for (const p of pend) {
          msg += `User ${p.username? "@"+p.username : p.userId} (id: ${p.userId}) code:${p.code} ts:${new Date(p.ts).toLocaleString()}\n`;
        }
        msg += "\nGunakan /getproof <user_id> untuk lihat bukti, /approve <user_id> atau /reject <user_id>";
        await sendMessage(API, chatId, msg);
        return new Response("ok");
      }

      if (cmd === "/getproof") {
        const target = parseInt(parts[1]);
        if (!target) return await sendMessage(API, chatId, "Gunakan: /getproof <user_id>");
        const p = globalThis.LIC.PENDING[target];
        if (!p) return await sendMessage(API, chatId, "Tidak ada bukti untuk user ini.");
        // send the stored file_id (photo)
        await sendPhotoByFileId(API, chatId, p.mediaFileId, `Bukti pembayaran dari ${p.username? "@"+p.username : p.userId} (code ${p.code})`);
        return new Response("ok");
      }

      if (cmd === "/approve") {
        const target = parseInt(parts[1]);
        if (!target) return await sendMessage(API, chatId, "Gunakan: /approve <user_id>");
        const p = globalThis.LIC.PENDING[target];
        if (!p) return await sendMessage(API, chatId, "Tidak ada pending untuk user ini.");
        // create license valid for LICENSE_VALID_DAYS from now
        const activeUntil = Date.now() + LICENSE_VALID_DAYS * MS_IN_DAY;
        globalThis.LIC.LICENSES[target] = { code: p.code, activeUntil, groups: [] };
        delete globalThis.LIC.PENDING[target];
        // notify user
        await sendMessage(API, target, `✅ Lisensimu disetujui oleh admin.\nKode lisensi: <code>${p.code}</code>\nLisensi aktif sampai: ${new Date(activeUntil).toLocaleString()}\nKirim /addgroup <chat_id> di private chat ini untuk mendaftarkan grup-mu.`);
        await sendMessage(API, chatId, `✅ Approved user ${target} (code ${p.code})`);
        pushLog(`Approved license for ${target} code ${p.code}`);
        return new Response("ok");
      }

      if (cmd === "/reject") {
        const target = parseInt(parts[1]);
        if (!target) return await sendMessage(API, chatId, "Gunakan: /reject <user_id>");
        const p = globalThis.LIC.PENDING[target];
        if (!p) return await sendMessage(API, chatId, "Tidak ada pending untuk user ini.");
        // notify user and remove pending
        delete globalThis.LIC.PENDING[target];
        await sendMessage(API, target, `❌ Maaf, bukti pembayaran kamu ditolak oleh admin. Silakan hubungi admin atau kirim bukti lagi.`);
        await sendMessage(API, chatId, `✅ Rejected user ${target}`);
        pushLog(`Rejected payment for ${target}`);
        return new Response("ok");
      }

      if (cmd === "/licenses") {
        const rows = Object.entries(globalThis.LIC.LICENSES).map(([uid, L]) => {
          return `User ${uid}: code ${L.code}, until ${new Date(L.activeUntil).toLocaleString()}, groups:${L.groups?L.groups.join(","):"-"}`;
        });
        await sendMessage(API, chatId, rows.length ? rows.join("\n") : "Tidak ada license aktif.");
        return new Response("ok");
      }

      if (cmd === "/revoke") {
        const target = parseInt(parts[1]);
        if (!target) return await sendMessage(API, chatId, "Gunakan: /revoke <user_id>");
        if (globalThis.LIC.LICENSES[target]) {
          delete globalThis.LIC.LICENSES[target];
          await sendMessage(API, chatId, `✅ Lisensi untuk ${target} dicabut.`);
          await sendMessage(API, target, `⚠️ Lisensimu telah dicabut oleh admin.`);
          pushLog(`Revoked license for ${target}`);
        } else {
          await sendMessage(API, chatId, `User ini tidak punya lisensi.`);
        }
        return new Response("ok");
      }

      // other admin commands can be added...
      return new Response("ok");
    }
  } // end private chat handler

  // === GROUP CHAT FLOW: Bot acts as satpam only for registered groups ===
  // Check if group is registered and owned by licensed user
  const groupReg = globalThis.LIC.GROUPS[chatId];
  if (!groupReg) {
    // group not registered — ignore (unless admin commands in group)
    // still allow admins to use /activate maybe
    if (text && text.startsWith("/activate")) {
      // /activate <license_code> used in group by owner to link group quickly
      const parts = text.split(/\s+/);
      const code = parts[1];
      if (!code) { await sendMessage(API, chatId, "Gunakan: /activate <kode_lisensi> (di private chat lebih aman)"); return new Response("ok"); }
      // find license by code
      const licEntry = Object.entries(globalThis.LIC.LICENSES).find(([uid, L]) => L.code === code);
      if (!licEntry) { await sendMessage(API, chatId, "Kode lisensi tidak ditemukan atau tidak aktif."); return new Response("ok"); }
      const [ownerId, L] = licEntry;
      // ensure the person invoking command is owner or admin
      // we can't be sure who invoked in group unless command includes reply or user is admin; simplest: require that the command is sent by the owner user (by id)
      // but Telegram exposes msg.from — require msg.from.id === ownerId OR msg.from is admin
      if (msg.from && (msg.from.id === parseInt(ownerId) || await isAdmin(API, chatId, msg.from.id))) {
        // link group
        globalThis.LIC.GROUPS[chatId] = { ownerUserId: parseInt(ownerId) };
        L.groups = L.groups || [];
        if (!L.groups.includes(chatId)) L.groups.push(chatId);
        await sendMessage(API, chatId, `✅ Bot sudah aktif di grup ini atas lisensi ${L.code}.`);
        await sendMessage(API, ADMIN_ID, `ℹ️ Group ${chatId} activated with license ${L.code} (owner ${ownerId})`);
        pushLog(`Group ${chatId} activated by ${msg.from.id} with license ${L.code}`);
      } else {
        await sendMessage(API, chatId, `Hanya pemilik lisensi atau admin grup yang dapat mengaktifkan.`);
      }
      return new Response("ok");
    }

    return new Response("no action"); // ignore non-registered groups
  }

  // If group is registered: run satpam features (use previous advanced logic or minimal)
  // For simplicity here, we will do: on new_chat_members -> run profile summary and warn logic (similar to previous)
  if (msg.new_chat_members && Array.isArray(msg.new_chat_members)) {
    for (const member of msg.new_chat_members) {
      if (member.is_bot) continue;
      // owner who added?
      const adder = msg.from || null;
      if (adder && await isAdmin(API, chatId, adder.id)) {
        await sendMessage(API, chatId, `✅ ${formatUserSimple(member)} ditambahkan oleh admin ${formatUserSimple(adder)}.`);
        await sendMessage(API, getAdminId(), `ℹ️ ${formatUserSimple(member)} added to group ${chatId} by admin ${formatUserSimple(adder)}.`);
        continue;
      }
      // check photo
      const photos = await (await fetch(`${API}/getUserProfilePhotos?user_id=${member.id}&limit=1`)).json();
      const photoCount = photos.ok ? photos.result.total_count || 0 : 0;
      let info = `👋 Profil baru: ${formatUserSimple(member)}\nFoto profil: ${photoCount}`;
      await sendMessage(API, chatId, info);
      if (photoCount === 0) {
        // warn logic (in-memory)
        const key = `${chatId}:${member.id}`;
        globalThis.LIC.PENDING_WARN = globalThis.LIC.PENDING_WARN || {};
        globalThis.LIC.PENDING_WARN[key] = (globalThis.LIC.PENDING_WARN[key] || 0) + 1;
        const w = globalThis.LIC.PENDING_WARN[key];
        await sendMessage(API, chatId, `⚠️ ${formatUserSimple(member)} belum punya foto. Peringatan ${w}/3`);
        await sendMessage(API, ADMIN_ID, `⚠️ ${formatUserSimple(member)} join ${chatId} no photo (warn ${w}/3)`);
        if (w >= 3) {
          // kick
          await fetch(`${API}/kickChatMember`, { method: "POST", headers:{ "content-type":"application/json"}, body: JSON.stringify({ chat_id: chatId, user_id: member.id })});
          await sendMessage(API, chatId, `🚫 ${formatUserSimple(member)} dikeluarkan (3 warnings).`);
          delete globalThis.LIC.PENDING_WARN[key];
        }
      }
    }
    return new Response("ok");
  }

  return new Response("no action");
}

// ------------------ UTILITIES ------------------

function generateLicenseCode() {
  const a = () => Math.random().toString(36).substring(2, 8).toUpperCase();
  return `LS-${a()}-${Math.floor(1000 + Math.random()*9000)}`;
}

async function sendMessage(API, chatId, text, parse_mode="HTML") {
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("sendMessage error", e);
  }
}

async function sendPhoto(API, chatId, url, caption="") {
  try {
    await fetch(`${API}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: url, caption }),
    });
  } catch (e) {
    console.error("sendPhoto error", e);
  }
}

async function sendPhotoByFileId(API, chatId, fileId, caption="") {
  try {
    await fetch(`${API}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: fileId, caption }),
    });
  } catch (e) {
    console.error("sendPhotoByFileId error", e);
  }
}

function pushLog(s) {
  globalThis.LIC.LOGS = globalThis.LIC.LOGS || [];
  globalThis.LIC.LOGS.push({ ts: Date.now(), text: s });
  // keep last 200 logs
  if (globalThis.LIC.LOGS.length > 200) globalThis.LIC.LOGS.shift();
}

function formatUserSimple(u) {
  return u.username ? `@${u.username} (${u.id})` : `${u.first_name || "(no name)"} (${u.id})`;
}

async function isAdmin(API, chatId, userId) {
  try {
    const res = await (await fetch(`${API}/getChatMember?chat_id=${chatId}&user_id=${userId}`)).json();
    return res.ok && (res.result.status === "creator" || res.result.status === "administrator");
  } catch { return false; }
}

function getAdminId() {
  // used in some places
  return (typeof FALLBACK_ADMIN !== "undefined") ? FALLBACK_ADMIN : null;
    }
    try {
      if (request.method === "POST") {
        const update = await request.json();
        // handle different update types
        if (update.message) return await handleMessage(update.message, API, env);
        if (update.my_chat_member || update.chat_member) {
          // optional: handle promotions/demotions/join via link events
          return new Response("chat_member update ignored");
        }
        return new Response("unsupported update");
      }
      return new Response("Bot Satpam Pro aktif ✅");
    } catch (err) {
      // global error catch -> log to ADMIN
      await safeSend(API, ADMIN_ID, `❗ Bot internal error: ${err.message}\n${err.stack || ""}`);
      return new Response("error", { status: 500 });
    }
  },
};

async function handleMessage(msg, API, env) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const fromId = from.id;
  const chatKey = String(chatId);

  // get chat settings (in-memory, fallback to DEFAULTS)
  const settings = globalThis.SAT.chatSettings[chatKey] || { ...DEFAULTS };

  // Update message history for flood/repeat detection
  if (!globalThis.SAT.messageCounts[chatKey]) globalThis.SAT.messageCounts[chatKey] = {};
  if (!globalThis.SAT.messageCounts[chatKey][fromId]) globalThis.SAT.messageCounts[chatKey][fromId] = [];

  // Purge old entries
  const now = Math.floor(Date.now() / 1000);
  globalThis.SAT.messageCounts[chatKey][fromId] = globalThis.SAT.messageCounts[chatKey][fromId]
    .filter(x => now - x.ts <= (settings.FLOOD_WINDOW_SEC || DEFAULTS.FLOOD_WINDOW_SEC));

  // If user is muted (temporary), ignore actions from them besides admin commands handling
  const muteKey = `${chatKey}:${fromId}`;
  const mutedUntil = globalThis.SAT.mutes[muteKey] || 0;
  if (mutedUntil > now) {
    // optionally delete their messages (only if bot has admin rights)
    try { await deleteMessageIfPossible(API, chatId, msg.message_id); } catch {}
    return new Response("user muted");
  } else if (mutedUntil && mutedUntil <= now) {
    delete globalThis.SAT.mutes[muteKey];
    await safeSend(API, ADMIN_ID, `🔔 Unmute auto for ${formatUser(from)} in chat ${chatId}`);
  }

  // 1) New members handling
  if (msg.new_chat_members && Array.isArray(msg.new_chat_members)) {
    for (const member of msg.new_chat_members) {
      if (member.is_bot) {
        await sendMessage(API, chatId, `🤖 Bot detected: ${formatUser(member)} (ignored)`);
        continue;
      }

      // If member in chat whitelist -> just greet
      if (isWhitelisted(chatId, member.id)) {
        await sendProfileSummary(API, chatId, member, "whitelisted");
        await safeSend(API, ADMIN_ID, `✅ Whitelisted joined: ${formatUser(member)} in ${chatId}`);
        continue;
      }

      // If the adder is admin (msg.from) -> respect admin add
      const adder = msg.from || null;
      if (adder && await isAdmin(API, chatId, adder.id)) {
        await sendProfileSummary(API, chatId, member, "added_by_admin", adder);
        await safeSend(API, ADMIN_ID, `ℹ️ ${formatUser(member)} added by admin ${formatUser(adder)} to ${chatId}`);
        continue;
      }

      // Gather profile info
      const photosCount = await getUserProfilePhotosCount(API, member.id);
      const hasUsername = !!member.username;
      const profileText = `👋 Profil baru:\nNama: ${escapeHtml(member.first_name||"")}${member.last_name? " "+escapeHtml(member.last_name):""}\nUsername: ${member.username? "@"+member.username:"(tidak ada)"}\nID: <code>${member.id}</code>\nFoto profil: <b>${photosCount}</b>`;

      // if user has no photo and no username -> suspicious but give warns
      if (photosCount === 0 || !hasUsername) {
        const warn = incrWarn(chatId, member.id);
        await sendMessage(API, chatId, profileText + `\n⚠️ Detected: ${photosCount===0 ? "no photo" : ""} ${!hasUsername?"no username":""}\nPeringatan: <b>${warn}</b>/${settings.WARN_LIMIT}`);
        await safeSend(API, ADMIN_ID, `⚠️ New suspicious join: ${formatUser(member)} in ${chatId}. Warn ${warn}/${settings.WARN_LIMIT}`);

        if (warn >= (settings.WARN_LIMIT || DEFAULTS.WARN_LIMIT)) {
          if (settings.SOFT_MODE) {
            // Soft mode = only notify admin, don't kick
            await sendMessage(API, chatId, `⚠️ [SOFT MODE] ${formatUser(member)} mencapai limit peringatan tetapi tidak di-kick.`);
            await safeSend(API, ADMIN_ID, `🔕 [SOFT MODE] ${formatUser(member)} reached warn limit in ${chatId}`);
            clearWarn(chatId, member.id);
          } else {
            // Kick (ban) user
            await kickMember(API, chatId, member.id);
            await sendMessage(API, chatId, `🚫 ${formatUser(member)} dibanned otomatis (mencapai ${warn} peringatan).`);
            await safeSend(API, ADMIN_ID, `🚨 Auto-ban: ${formatUser(member)} in ${chatId} after ${warn} warns`);
            clearWarn(chatId, member.id);
          }
        }
      } else {
        // welcome and show profile summary
        await sendProfileSummary(API, chatId, member, "welcome");
        await safeSend(API, ADMIN_ID, `👋 New member safe: ${formatUser(member)} in ${chatId}`);
      }
    }
    return new Response("handled new members");
  }

  // 2) Regular messages: anti-flood, repeat, link, media filters
  const text = (msg.text || msg.caption || "") .trim();
  globalThis.SAT.messageCounts[chatKey][fromId].push({ ts: now, text });

  // Flood detection
  const count = globalThis.SAT.messageCounts[chatKey][fromId].length;
  if (count > (settings.FLOOD_COUNT || DEFAULTS.FLOOD_COUNT)) {
    const warn = incrWarn(chatId, fromId);
    await sendMessage(API, chatId, `⚠️ ${formatUser(from)} terdeteksi flood (${count} pesan dalam ${settings.FLOOD_WINDOW_SEC}s). Peringatan ${warn}/${settings.WARN_LIMIT}`);
    await safeSend(API, ADMIN_ID, `⚠️ Flood: ${formatUser(from)} sent ${count} msgs in ${chatId}`);
    if (warn >= (settings.WARN_LIMIT||DEFAULTS.WARN_LIMIT)) {
      if (settings.SOFT_MODE) {
        await sendMessage(API, chatId, `[SOFT MODE] ${formatUser(from)} reached warn limit for flood.`);
        clearWarn(chatId, fromId);
      } else {
        await muteMember(API, chatId, fromId, settings.TEMP_MUTE_SECONDS || DEFAULTS.TEMP_MUTE_SECONDS);
        await sendMessage(API, chatId, `🔇 ${formatUser(from)} dimute sementara karena flood.`);
        await safeSend(API, ADMIN_ID, `🔕 Auto-mute ${formatUser(from)} in ${chatId} due to flood`);
        clearWarn(chatId, fromId);
      }
    }
    // optionally delete message
    try { await deleteMessageIfPossible(API, chatId, msg.message_id); } catch {}
    return new Response("flood handled");
  }

  // Repeat detection (same text repeated)
  const recent = globalThis.SAT.messageCounts[chatKey][fromId].map(x => x.text).filter(Boolean);
  const repeats = recent.filter(t => t === text).length;
  if (text && repeats >= (settings.REPEAT_THRESHOLD || DEFAULTS.REPEAT_THRESHOLD)) {
    const warn = incrWarn(chatId, fromId);
    await sendMessage(API, chatId, `⚠️ ${formatUser(from)} mengulang pesan (${repeats}x). Peringatan ${warn}/${settings.WARN_LIMIT}`);
    await safeSend(API, ADMIN_ID, `⚠️ Repeat: ${formatUser(from)} in ${chatId} (${repeats}x)`);
    if (warn >= (settings.WARN_LIMIT||DEFAULTS.WARN_LIMIT)) {
      if (settings.SOFT_MODE) {
        await sendMessage(API, chatId, `[SOFT MODE] ${formatUser(from)} reached repeat warn limit.`);
        clearWarn(chatId, fromId);
      } else {
        await kickMember(API, chatId, fromId);
        await sendMessage(API, chatId, `🚫 ${formatUser(from)} dibanned otomatis karena mengulang pesan.`);
        await safeSend(API, ADMIN_ID, `🚨 Auto-ban repeat: ${formatUser(from)} in ${chatId}`);
        clearWarn(chatId, fromId);
      }
    }
    try { await deleteMessageIfPossible(API, chatId, msg.message_id); } catch {}
    return new Response("repeat handled");
  }

  // Link detection
  if (!settings.ALLOW_LINKS && (msg.entities || msg.caption_entities)) {
    const entities = msg.entities || msg.caption_entities || [];
    for (const ent of entities) {
      if (ent.type === "url" || ent.type === "text_link" || ent.type === "mention") {
        let url = null;
        if (ent.type === "text_link" && ent.url) url = ent.url;
        else if (ent.type === "url") {
          // extract substring
          try { url = (msg.text || msg.caption).substring(ent.offset, ent.offset + ent.length); } catch {}
        }

        if (url) {
          // check whitelist domains
          const allowed = (settings.ALLOWED_DOMAINS || DEFAULTS.ALLOWED_DOMAINS).some(d => url.includes(d));
          if (!allowed) {
            const warn = incrWarn(chatId, fromId);
            await sendMessage(API, chatId, `⚠️ ${formatUser(from)} mengirim link yang tidak diizinkan: <code>${escapeHtml(url)}</code>. Peringatan ${warn}/${settings.WARN_LIMIT}`);
            await safeSend(API, ADMIN_ID, `⚠️ Link block: ${formatUser(from)} sent ${url} in ${chatId}`);
            try { await deleteMessageIfPossible(API, chatId, msg.message_id); } catch {}
            if (warn >= (settings.WARN_LIMIT || DEFAULTS.WARN_LIMIT)) {
              if (settings.SOFT_MODE) {
                await sendMessage(API, chatId, `[SOFT MODE] reached link warn limit for ${formatUser(from)}`);
                clearWarn(chatId, fromId);
              } else {
                await kickMember(API, chatId, fromId);
                await sendMessage(API, chatId, `🚫 ${formatUser(from)} dibanned otomatis (link).`);
                await safeSend(API, ADMIN_ID, `🚨 Auto-ban link: ${formatUser(from)} in ${chatId}`);
                clearWarn(chatId, fromId);
              }
            }
            return new Response("link handled");
          }
        }
      }
    }
  }

  // Media filtering (image, video, document, sticker)
  if (msg.sticker && settings.BLOCK_MEDIA_TYPES.sticker) {
    const warn = incrWarn(chatId, fromId);
    await sendMessage(API, chatId, `⚠️ Sticker diblokir. Peringatan ${warn}/${settings.WARN_LIMIT}`);
    try { await deleteMessageIfPossible(API, chatId, msg.message_id); } catch {}
    return new Response("sticker blocked");
  }
  if (msg.video && settings.BLOCK_MEDIA_TYPES.video) {
    const warn = incrWarn(chatId, fromId);
    await sendMessage(API, chatId, `⚠️ Video diblokir. Peringatan ${warn}/${settings.WARN_LIMIT}`);
    try { await deleteMessageIfPossible(API, chatId, msg.message_id); } catch {}
    return new Response("video blocked");
  }
  if (msg.document && settings.BLOCK_MEDIA_TYPES.document) {
    const warn = incrWarn(chatId, fromId);
    await sendMessage(API, chatId, `⚠️ File diblokir. Peringatan ${warn}/${settings.WARN_LIMIT}`);
    try { await deleteMessageIfPossible(API, chatId, msg.message_id); } catch {}
    return new Response("document blocked");
  }

  // Admin commands (only admin can run)
  if (text && text.startsWith("/")) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    // Only allow admin or ADMIN_ID to run admin commands
    const invokerIsAdmin = await isAdmin(API, chatId, fromId);
    if (!invokerIsAdmin && fromId !== ADMIN_ID) {
      await sendMessage(API, chatId, "❌ Kamu bukan admin.");
      return new Response("not admin");
    }

    // handle admin commands with args
    switch (cmd) {
      case "/status":
        await sendStatus(API, chatId);
        break;
      case "/settings":
        await sendMessage(API, chatId, `<pre>${JSON.stringify(settings, null, 2)}</pre>`, "HTML");
        break;
      case "/warn":
      case "/clearwarn":
      case "/ban":
      case "/unban":
      case "/mute":
      case "/unmute":
      case "/whitelist":
      case "/unwhitelist":
      case "/set":
        await handleAdminCmd(API, chatId, parts, settings);
        break;
      default:
        await sendMessage(API, chatId, "❓ Perintah admin tidak dikenali.");
    }
    return new Response("admin cmd handled");
  }

  return new Response("ok");
}

// -------------------- Helper / admin functions --------------------

async function handleAdminCmd(API, chatId, parts, settings) {
  const cmd = parts[0].toLowerCase();
  const arg = parts[1];
  const chatKey = String(chatId);

  if (cmd === "/warn") {
    const id = parseInt(arg);
    if (!id) return await sendMessage(API, chatId, "Gunakan: /warn <user_id>");
    const w = incrWarn(chatId, id);
    await sendMessage(API, chatId, `⚠️ User ${id} warned (${w})`);
    await safeSend(API, ADMIN_ID, `Admin warned ${id} in ${chatId} (now ${w})`);
    return;
  }

  if (cmd === "/clearwarn") {
    const id = parseInt(arg);
    if (!id) return await sendMessage(API, chatId, "Gunakan: /clearwarn <user_id>");
    clearWarn(chatId, id);
    await sendMessage(API, chatId, `✅ Warn cleared for ${id}`);
    return;
  }

  if (cmd === "/ban") {
    const id = parseInt(arg);
    if (!id) return await sendMessage(API, chatId, "Gunakan: /ban <user_id>");
    await kickMember(API, chatId, id);
    await sendMessage(API, chatId, `🚫 ${id} banned`);
    await safeSend(API, ADMIN_ID, `Admin banned ${id} in ${chatId}`);
    clearWarn(chatId, id);
    return;
  }

  if (cmd === "/unban") {
    const id = parseInt(arg);
    if (!id) return await sendMessage(API, chatId, "Gunakan: /unban <user_id>");
    await unbanMember(API, chatId, id);
    await sendMessage(API, chatId, `✅ ${id} unbanned`);
    return;
  }

  if (cmd === "/mute") {
    const id = parseInt(arg);
    const secs = parseInt(parts[2]) || DEFAULTS.TEMP_MUTE_SECONDS;
    if (!id) return await sendMessage(API, chatId, "Gunakan: /mute <user_id> <seconds?>");
    await muteMember(API, chatId, id, secs);
    await sendMessage(API, chatId, `🔇 ${id} muted for ${secs}s`);
    await safeSend(API, ADMIN_ID, `Admin muted ${id} in ${chatId} for ${secs}s`);
    return;
  }

  if (cmd === "/unmute") {
    const id = parseInt(arg);
    if (!id) return await sendMessage(API, chatId, "Gunakan: /unmute <user_id>");
    delete globalThis.SAT.mutes[`${chatKey}:${id}`];
    await sendMessage(API, chatId, `🔊 ${id} unmuted`);
    return;
  }

  if (cmd === "/whitelist") {
    const id = parseInt(arg);
    if (!id) return await sendMessage(API, chatId, "Gunakan: /whitelist <user_id>");
    globalThis.SAT.whitelist[`${chatKey}:${id}`] = true;
    await sendMessage(API, chatId, `✅ ${id} whitelisted`);
    return;
  }

  if (cmd === "/unwhitelist") {
    const id = parseInt(arg);
    if (!id) return await sendMessage(API, chatId, "Gunakan: /unwhitelist <user_id>");
    delete globalThis.SAT.whitelist[`${chatKey}:${id}`];
    await sendMessage(API, chatId, `✅ ${id} removed from whitelist`);
    return;
  }

  if (cmd === "/set") {
    // example: /set mode soft OR /set flood 6 10 OR /set warns 4
    const sub = parts[1];
    if (!sub) return await sendMessage(API, chatId, "Gunakan: /set <mode|flood|warns> ...");
    if (!globalThis.SAT.chatSettings[chatKey]) globalThis.SAT.chatSettings[chatKey] = { ...DEFAULTS };
    if (sub === "mode") {
      const v = parts[2];
      globalThis.SAT.chatSettings[chatKey].SOFT_MODE = (v === "soft");
      await sendMessage(API, chatId, `✅ Mode di-set ke ${v}`);
      return;
    }
    if (sub === "flood") {
      const cnt = parseInt(parts[2]) || DEFAULTS.FLOOD_COUNT;
      const win = parseInt(parts[3]) || DEFAULTS.FLOOD_WINDOW_SEC;
      globalThis.SAT.chatSettings[chatKey].FLOOD_COUNT = cnt;
      globalThis.SAT.chatSettings[chatKey].FLOOD_WINDOW_SEC = win;
      await sendMessage(API, chatId, `✅ Flood setting: ${cnt} msgs / ${win}s`);
      return;
    }
    if (sub === "warns") {
      const n = parseInt(parts[2]) || DEFAULTS.WARN_LIMIT;
      globalThis.SAT.chatSettings[chatKey].WARN_LIMIT = n;
      await sendMessage(API, chatId, `✅ Warn limit set to ${n}`);
      return;
    }
    return await sendMessage(API, chatId, "Unknown /set subcommand");
  }
}

async function sendStatus(API, chatId) {
  const chatKey = String(chatId);
  const settings = globalThis.SAT.chatSettings[chatKey] || DEFAULTS;
  const activeMutes = Object.entries(globalThis.SAT.mutes)
    .filter(([k, v]) => k.startsWith(chatKey + ":") && v > Math.floor(Date.now()/1000))
    .map(([k, v]) => `${k.split(":")[1]} until ${v}`);
  const s = `📊 Status\nMode: ${settings.SOFT_MODE ? "SOFT" : "STRICT"}\nWarn limit: ${settings.WARN_LIMIT}\nFlood: ${settings.FLOOD_COUNT}/${settings.FLOOD_WINDOW_SEC}s\nMutes: ${activeMutes.length}\nWhitelisted: ${Object.keys(globalThis.SAT.whitelist).filter(k=>k.startsWith(chatKey+":")).length}`;
  await sendMessage(API, chatId, s);
}

// -------------------- Util functions --------------------

function incrWarn(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const now = Math.floor(Date.now()/1000);
  const rec = globalThis.SAT.warns[key] || { count: 0, last: now };
  // expire warn after 3 days
  if (now - rec.last > (3*24*3600)) rec.count = 0;
  rec.count += 1;
  rec.last = now;
  globalThis.SAT.warns[key] = rec;
  return rec.count;
}

function clearWarn(chatId, userId) {
  delete globalThis.SAT.warns[`${chatId}:${userId}`];
}

function isWhitelisted(chatId, userId) {
  return !!globalThis.SAT.whitelist[`${chatId}:${userId}`];
}

async function getUserProfilePhotosCount(API, userId) {
  try {
    const r = await (await fetch(`${API}/getUserProfilePhotos?user_id=${userId}&limit=1`)).json();
    return r.ok ? (r.result.total_count || 0) : 0;
  } catch {
    return 0;
  }
}

function formatUser(u) {
  if (!u) return "(unknown)";
  return u.username ? `@${u.username} (${u.id})` : `${escapeHtml(u.first_name||"")} (${u.id})`;
}

async function sendProfileSummary(API, chatId, member, reason="welcome", adder=null) {
  const photosCount = await getUserProfilePhotosCount(API, member.id);
  let txt = `👋 <b>Profil Baru</b>\nNama: <code>${escapeHtml(member.first_name||"")}${member.last_name? " "+escapeHtml(member.last_name):""}</code>\nUsername: <code>${member.username? "@"+member.username : "(tidak ada)"}</code>\nID: <code>${member.id}</code>\nFoto Profil: <b>${photosCount}</b>\n`;
  if (reason === "whitelisted") txt += `✅ User ini di-whitelist.`;
  if (reason === "added_by_admin") txt += `ℹ️ Ditambahkan oleh admin ${formatUser(adder)}.`;
  if (reason === "welcome") txt += `✅ Terlihat aman. Selamat datang!`;
  await sendMessage(API, chatId, txt);
}

async function sendMessag            await sendMessage(API, chatId, `👋 Selamat datang, ${name}!`);
          }
        }
        return new Response("OK");
      }

      // 🧩 2. Perintah admin
      if (text.startsWith("/")) {
        const [command, arg] = text.split(" ");
        if (!(await isAdmin(API, chatId, from.id)) && from.id !== ADMIN_ID) {
          await sendMessage(API, chatId, "❌ Kamu bukan admin!");
          return new Response("Unauthorized");
        }

        const userId = parseInt(arg);
        if (isNaN(userId)) {
          await sendMessage(API, chatId, "⚠️ Harus pakai ID numerik.");
          return new Response("Invalid ID");
        }

        switch (command) {
          case "/warn":
            globalThis.warns[`${chatId}:${userId}`] = (globalThis.warns[`${chatId}:${userId}`] || 0) + 1;
            await sendMessage(API, chatId, `⚠️ User ${userId} diberi peringatan.`);
            break;
          case "/clearwarn":
            delete globalThis.warns[`${chatId}:${userId}`];
            await sendMessage(API, chatId, `✅ Peringatan untuk ${userId} dihapus.`);
            break;
          case "/warns":
            const count = globalThis.warns[`${chatId}:${userId}`] || 0;
            await sendMessage(API, chatId, `ℹ️ Peringatan user ${userId}: ${count}/${WARN_LIMIT}`);
            break;
          case "/ban":
            await fetch(`${API}/kickChatMember`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, user_id: userId }),
            });
            await sendMessage(API, chatId, `🚫 User ${userId} dikeluarkan oleh admin.`);
            break;
          case "/unban":
            await fetch(`${API}/unbanChatMember`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, user_id: userId }),
            });
            await sendMessage(API, chatId, `✅ User ${userId} telah diunban.`);
            break;
          default:
            await sendMessage(API, chatId, "❓ Perintah tidak dikenal.");
        }

        return new Response("Command OK");
      }

      return new Response("OK");
    }

    return new Response("Bot aktif ✅");
  },
};

// 🔧 Fungsi bantu
async function sendMessage(API, chatId, text, parse = "HTML") {
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parse }),
  });
}

async function isAdmin(API, chatId, userId) {
  try {
    const res = await fetch(`${API}/getChatMember?chat_id=${chatId}&user_id=${userId}`).then(r => r.json());
    if (!res.ok) return false;
    const s = res.result.status;
    return s === "creator" || s === "administrator";
  } catch {
    return false;
  }
              }
