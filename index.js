// bot-satpam-lisensi-fix-nospam.js
// ✅ Versi fix anti-spam loop Telegram
// Bot Satpam Berlisensi (Cloudflare Worker) — by GPT-5

const TOKEN = "7819500627:AAGR8QKx4G7J-HMBczMVj3GT3aTBgcBLmlo";
const ADMIN_IDS = [5560906270];
const API = `https://api.telegram.org/bot${TOKEN}`;
const QRIS_LINK = "https://raw.githubusercontent.com/Sigitbaberon/qris/refs/heads/main/qr_ID1025423347687_29.09.25_175910930_1759109315016.jpeg";
const LICENSE_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

// --- Memory storage (non-KV)
if (!globalThis.DB) {
  globalThis.DB = {
    HANDLED: new Set(),   // untuk mencegah spam / loop
    PENDING: {},
    LICENSES: {},
  };
}

export default {
  async fetch(req) {
    if (req.method !== "POST") return new Response("Bot aktif ✅");
    const update = await req.json();

    // Ambil data update
    const msg = update.message;
    if (!msg) return new Response("No message");

    const idKey = `${msg.chat.id}-${msg.message_id}`;
    if (globalThis.DB.HANDLED.has(idKey)) return new Response("Duplicate ignored");
    globalThis.DB.HANDLED.add(idKey);

    try {
      await handleMessage(msg);
    } catch (err) {
      console.error("Bot error:", err);
      await safeSend(ADMIN_IDS[0], `❗Error: ${err.message}`);
    }

    // ⚡ Telegram butuh respon cepat
    return new Response("ok", { status: 200 });
  },
};

// === CORE ===
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const userId = from.id;
  const text = (msg.text || "").trim();
  const isPrivate = msg.chat.type === "private";
  const isAdmin = ADMIN_IDS.includes(userId);

  // === PRIVATE CHAT ===
  if (isPrivate) {
    // /start
    if (text === "/start") {
      await sendMessage(
        chatId,
        `👋 Halo ${from.first_name || "teman"}!\n\n` +
          `Bot ini adalah *Satpam Grup* dengan sistem lisensi berlangganan.\n` +
          `Untuk aktivasi, silakan bayar lewat QRIS di bawah lalu kirim bukti transfer ke sini.`,
        "Markdown"
      );
      await sendPhoto(chatId, QRIS_LINK, "📷 Scan QRIS di atas untuk membayar lisensi 30 hari.");
      return;
    }

    // Foto bukti pembayaran
    if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      const code = genCode();
      globalThis.DB.PENDING[userId] = {
        userId,
        username: from.username || "",
        fileId: largest.file_id,
        code,
        ts: Date.now(),
      };
      await sendMessage(chatId, `✅ Bukti diterima!\nKode verifikasi: \`${code}\`\nTunggu admin menyetujuinya.`, "Markdown");
      for (const adminId of ADMIN_IDS) {
        await sendMessage(adminId, `💰 Bukti pembayaran baru dari [${from.first_name}](tg://user?id=${userId})\nKode: \`${code}\`\nGunakan /approve ${userId} atau /reject ${userId}.`, "Markdown");
      }
      return;
    }

    // User kirim kode lisensi
    if (/^LS-[A-Z0-9-]+$/i.test(text)) {
      const lic = globalThis.DB.LICENSES[userId];
      if (lic && lic.code === text) {
        await sendMessage(chatId, `✅ Lisensi aktif hingga ${formatDate(lic.exp)}.`);
      } else {
        await sendMessage(chatId, `❌ Kode tidak valid atau belum disetujui.`);
      }
      return;
    }

    // Admin commands
    if (text.startsWith("/")) {
      const [cmd, arg] = text.split(" ");
      if (!isAdmin) {
        await sendMessage(chatId, "❌ Kamu bukan admin!");
        return;
      }

      switch (cmd) {
        case "/pending":
          return sendPending(chatId);
        case "/approve":
          return approveLicense(chatId, parseInt(arg));
        case "/reject":
          return rejectLicense(chatId, parseInt(arg));
        case "/licenses":
          return listLicenses(chatId);
        default:
          await sendMessage(chatId, "📘 Perintah admin:\n/pending\n/approve <id>\n/reject <id>\n/licenses");
      }
      return;
    }
  }

  // === GROUP ===
  if (msg.new_chat_members) {
    for (const member of msg.new_chat_members) {
      if (member.is_bot) continue;
      const photoCount = await getPhotos(member.id);
      await sendMessage(chatId, `👋 ${member.first_name} bergabung.\nFoto profil: ${photoCount}`);
      if (photoCount === 0) {
        await sendMessage(chatId, `⚠️ ${member.first_name} belum punya foto profil.`);
      }
    }
  }
}

// === ADMIN HELPERS ===
async function sendPending(chatId) {
  const pend = Object.values(globalThis.DB.PENDING);
  if (pend.length === 0) return sendMessage(chatId, "Tidak ada pembayaran pending.");
  let msg = "📋 Pending pembayaran:\n";
  for (const p of pend) {
    msg += `User ${p.username || p.userId} — kode ${p.code}\n`;
  }
  await sendMessage(chatId, msg);
}

async function approveLicense(chatId, userId) {
  const pend = globalThis.DB.PENDING[userId];
  if (!pend) return sendMessage(chatId, "User tidak ada di daftar pending.");
  const exp = Date.now() + LICENSE_DAYS * DAY_MS;
  globalThis.DB.LICENSES[userId] = { code: pend.code, exp };
  delete globalThis.DB.PENDING[userId];
  await sendMessage(chatId, `✅ Lisensi disetujui untuk ${userId}.`);
  await sendMessage(userId, `✅ Lisensi kamu disetujui!\nKode: \`${pend.code}\`\nAktif hingga ${formatDate(exp)}.`, "Markdown");
}

async function rejectLicense(chatId, userId) {
  const pend = globalThis.DB.PENDING[userId];
  if (!pend) return sendMessage(chatId, "User tidak ada di pending.");
  delete globalThis.DB.PENDING[userId];
  await sendMessage(chatId, `❌ Pembayaran user ${userId} ditolak.`);
  await sendMessage(userId, `❌ Pembayaran kamu ditolak. Silakan hubungi admin.`);
}

async function listLicenses(chatId) {
  const list = Object.entries(globalThis.DB.LICENSES);
  if (list.length === 0) return sendMessage(chatId, "Belum ada lisensi aktif.");
  let msg = "💼 Lisensi aktif:\n";
  for (const [id, L] of list) {
    msg += `User ${id} — exp: ${formatDate(L.exp)}\n`;
  }
  await sendMessage(chatId, msg);
}

// === UTIL ===
function genCode() {
  return `LS-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

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

async function safeSend(chatId, text) {
  try {
    await sendMessage(chatId, text);
  } catch {}
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("id-ID");
    }
