// bot-satpam-pro.js
// Cloudflare Worker (module) - advanced satpam bot
// Bindings: none required. If you use Wrangler, set secret "BOT_TOKEN" to your bot token.
// If env.BOT_TOKEN not set, it will fallback to hardcoded TOKEN below (not recommended).

const FALLBACK_TOKEN = "7522192709:AAFDwX-Lng-_3FUtr6oAiFu-nfD_XLMCsd8"; // Prefer env secret instead
const ADMIN_ID = 7729648778; // Chat ID where bot logs (private chat or admin group). Ganti jika perlu.

const DEFAULTS = {
  WARN_LIMIT: 3,
  SOFT_MODE: true, // jika true -> hanya peringatan; jika false -> auto-kick di limit
  FLOOD_COUNT: 5,
  FLOOD_WINDOW_SEC: 10,
  REPEAT_THRESHOLD: 3, // berapa kali mengulang pesan yang sama untuk warn
  ALLOW_LINKS: false, // default blok link kecuali domain whitelist
  ALLOWED_DOMAINS: ["t.me/yourgroup", "yourdomain.com"], // contoh
  BLOCK_MEDIA_TYPES: { video: false, sticker: false, gif: false, document: false }, // atur sesuai kebutuhan
  TEMP_MUTE_SECONDS: 60 * 5,
};

export default {
  async fetch(request, env) {
    const TOKEN = env && env.BOT_TOKEN ? env.BOT_TOKEN : FALLBACK_TOKEN;
    const API = `https://api.telegram.org/bot${TOKEN}`;

    // initialize global storage (in-memory)
    if (!globalThis.SAT) {
      globalThis.SAT = {
        warns: {},           // key: chatId:userId -> {count, last}
        messageCounts: {},   // key: chatId:userId -> [{ts, text}, ...] used for flood and repeat detection
        mutes: {},           // key: chatId:userId -> until_ts
        whitelist: {},       // key: chatId:userId -> true
        blacklist: {},       // key: chatId:userId -> true
        chatSettings: {},    // key: chatId -> overrides of DEFAULTS
      };
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
