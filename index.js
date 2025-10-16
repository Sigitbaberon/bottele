// Satpam Bot Berlisensi (Stable Cloudflare Worker KV Version)
// KV ID: 236d68b5c6964ee79fc7f0afbda2340e

const TOKEN = "7819500627:AAGR8QKx4G7J-HMBczMVj3GT3aTBgcBLmlo";
const ADMIN_IDS = [5560906270];
const API = `https://api.telegram.org/bot${TOKEN}`;
const QRIS_LINK = "https://raw.githubusercontent.com/Sigitbaberon/qris/refs/heads/main/qr_ID1025423347687_29.09.25_175910930_1759109315016.jpeg";
const LICENSE_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("✅ Satpam Bot dengan KV aktif");
    const update = await req.json();
    const msg = update.message;
    if (!msg) return new Response("No message");

    const key = `${msg.chat.id}-${msg.message_id}`;
    if (await env.DB.get(key)) return new Response("duplicate ignored");
    await env.DB.put(key, "1", { expirationTtl: 60 });

    await handleMessage(msg, env);
    return new Response("ok", { status: 200 });
  },
};

// === CORE HANDLER ===
async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || "";
  const name = msg.from.first_name || "";
  const text = (msg.text || "").trim();
  const isPrivate = msg.chat.type === "private";
  const isAdmin = ADMIN_IDS.includes(userId);

  // === PRIVATE CHAT ===
  if (isPrivate) {
    // /start
    if (text === "/start") {
      await sendMessage(chatId,
        `👋 Halo ${name}!\n\n` +
        `Bot ini adalah *Satpam Grup Berlisensi*.\n` +
        `Untuk aktivasi lisensi, silakan bayar via QRIS berikut lalu kirim bukti transfer.`,
        "Markdown");
      await sendPhoto(chatId, QRIS_LINK, "📷 Scan QRIS di atas untuk bayar lisensi 30 hari.");
      return;
    }

    // Upload bukti pembayaran
    if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      const code = genCode();
      const pending = { userId, username, name, fileId: largest.file_id, code, ts: Date.now() };
      await env.DB.put(`pending:${userId}`, JSON.stringify(pending));
      await sendMessage(chatId, `✅ Bukti diterima!\nKode verifikasi: \`${code}\`\nTunggu admin menyetujuinya.`, "Markdown");

      for (const adminId of ADMIN_IDS) {
        await sendMessage(
          adminId,
          `💰 Bukti pembayaran baru dari [${name}](tg://user?id=${userId})\nKode: \`${code}\`\nGunakan:\n/approve ${userId} atau /approve ${code}\n/reject ${userId} atau /reject ${code}`,
          "Markdown"
        );
      }
      return;
    }

    // Admin Commands
    if (text.startsWith("/")) {
      const [cmd, arg] = text.split(" ");
      if (!isAdmin) return sendMessage(chatId, "❌ Kamu bukan admin!");

      switch (cmd) {
        case "/pending": return listPending(chatId, env);
        case "/approve": return approve(chatId, env, arg);
        case "/reject": return reject(chatId, env, arg);
        case "/licenses": return listLicenses(chatId, env);
        default:
          await sendMessage(chatId, "📘 Perintah admin:\n/pending\n/approve <id|kode>\n/reject <id|kode>\n/licenses");
      }
    }
  }

  // === GROUP ===
  if (msg.new_chat_members) {
    for (const member of msg.new_chat_members) {
      if (member.is_bot) continue;
      const photoCount = await getPhotos(member.id);
      await sendMessage(chatId, `👋 ${member.first_name} bergabung.\nFoto profil: ${photoCount}`);
      if (photoCount === 0) await sendMessage(chatId, `⚠️ ${member.first_name} belum punya foto profil.`);
    }
  }
}

// === FUNCTIONS ===

async function listPending(chatId, env) {
  const list = await env.DB.list({ prefix: "pending:" });
  if (list.keys.length === 0) return sendMessage(chatId, "Tidak ada pembayaran pending.");
  let msg = "📋 Pending pembayaran:\n";
  for (const k of list.keys) {
    const p = JSON.parse(await env.DB.get(k.name));
    msg += `User ${p.username || p.userId} — kode ${p.code}\n`;
  }
  await sendMessage(chatId, msg);
}

async function approve(chatId, env, arg) {
  if (!arg) return sendMessage(chatId, "Gunakan /approve <user_id> atau /approve <kode>.");
  let data = await env.DB.get(`pending:${arg}`);
  let userKey = `pending:${arg}`;

  // Cari berdasarkan kode lisensi jika tidak ditemukan berdasarkan userId
  if (!data) {
    const list = await env.DB.list({ prefix: "pending:" });
    for (const k of list.keys) {
      const d = JSON.parse(await env.DB.get(k.name));
      if (d.code === arg) {
        data = JSON.stringify(d);
        userKey = k.name;
        break;
      }
    }
  }

  if (!data) return sendMessage(chatId, "❌ User tidak ada di daftar pending.");

  const p = JSON.parse(data);
  const exp = Date.now() + LICENSE_DAYS * DAY_MS;

  await env.DB.put(`license:${p.userId}`, JSON.stringify({ code: p.code, exp }));
  await env.DB.delete(userKey);

  await sendMessage(chatId, `✅ Lisensi disetujui untuk ${p.username || p.userId}.`);
  await sendMessage(p.userId, `✅ Lisensi kamu disetujui!\nKode: \`${p.code}\`\nAktif hingga ${formatDate(exp)}.`, "Markdown");
}

async function reject(chatId, env, arg) {
  if (!arg) return sendMessage(chatId, "Gunakan /reject <user_id> atau /reject <kode>.");
  let data = await env.DB.get(`pending:${arg}`);
  let userKey = `pending:${arg}`;

  // Cari berdasarkan kode lisensi jika tidak ditemukan berdasarkan userId
  if (!data) {
    const list = await env.DB.list({ prefix: "pending:" });
    for (const k of list.keys) {
      const d = JSON.parse(await env.DB.get(k.name));
      if (d.code === arg) {
        data = JSON.stringify(d);
        userKey = k.name;
        break;
      }
    }
  }

  if (!data) return sendMessage(chatId, "❌ User tidak ada di daftar pending.");

  const p = JSON.parse(data);
  await env.DB.delete(userKey);
  await sendMessage(chatId, `❌ Pembayaran user ${p.username || p.userId} ditolak.`);
  await sendMessage(p.userId, `❌ Pembayaran kamu ditolak. Silakan hubungi admin.`);
}

async function listLicenses(chatId, env) {
  const list = await env.DB.list({ prefix: "license:" });
  if (list.keys.length === 0) return sendMessage(chatId, "Belum ada lisensi aktif.");
  let msg = "💼 Lisensi aktif:\n";
  for (const k of list.keys) {
    const L = JSON.parse(await env.DB.get(k.name));
    const uid = k.name.replace("license:", "");
    msg += `User ${uid} — exp: ${formatDate(L.exp)}\n`;
  }
  await sendMessage(chatId, msg);
}

// === UTILITIES ===

async function sendMessage(chatId, text, mode = "HTML") {
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: mode }),
  });
}

async function sendPhoto(chatId, url, caption = "") {
  await fetch(`${API}/sendPhoto`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: url, caption }),
  });
}

async function getPhotos(userId) {
  try {
    const res = await fetch(`${API}/getUserProfilePhotos?user_id=${userId}&limit=1`);
    const d = await res.json();
    return d.ok ? d.result.total_count : 0;
  } catch {
    return 0;
  }
}

function genCode() {
  return `LS-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("id-ID");
      }
