// bot-satpam-lisensi-fix.js
// Satpam Bot dengan lisensi - admin sudah diperbaiki

const FALLBACK_TOKEN = "7819500627:AAGR8QKx4G7J-HMBczMVj3GT3aTBgcBLmlo"; // token bot kamu
const ADMIN_IDS = [5560906270]; // kamu adalah admin utama
const QRIS_LINK = "https://raw.githubusercontent.com/Sigitbaberon/qris/refs/heads/main/qr_ID1025423347687_29.09.25_175910930_1759109315016.jpeg";
const LICENSE_VALID_DAYS = 30;
const MS_IN_DAY = 24 * 3600 * 1000;

export default {
  async fetch(request) {
    const TOKEN = FALLBACK_TOKEN;
    const API = `https://api.telegram.org/bot${TOKEN}`;

    if (!globalThis.LIC) {
      globalThis.LIC = {
        PENDING: {},
        LICENSES: {},
        GROUPS: {},
      };
    }

    if (request.method === "POST") {
      const update = await request.json();
      if (update.message) return handleMessage(update.message, API);
    }

    return new Response("Bot Satpam Berlisensi Aktif ✅");
  },
};

async function handleMessage(msg, API) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const userId = from.id;
  const text = (msg.text || "").trim();
  const isPrivate = msg.chat.type === "private";

  // ✅ cek apakah pengirim adalah admin
  const isAdmin = ADMIN_IDS.includes(userId);

  // --- Mode Private Chat (/start, pembayaran, lisensi) ---
  if (isPrivate) {
    // /start
    if (text === "/start") {
      await sendMessage(API, chatId, 
        `👋 Halo ${from.first_name || "User"}!\n\n` +
        `Untuk menggunakan Satpam Bot di grup, kamu perlu lisensi aktif selama ${LICENSE_VALID_DAYS} hari.\n` +
        `Silakan bayar melalui QRIS berikut, lalu kirim bukti transfer (foto) ke sini.`
      );
      await sendPhoto(API, chatId, QRIS_LINK, "Scan QRIS di atas untuk pembayaran.");
      return;
    }

    // Jika kirim foto bukti pembayaran
    if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      const code = generateLicenseCode();
      globalThis.LIC.PENDING[userId] = {
        userId,
        username: from.username || "",
        photoId: largest.file_id,
        code,
        ts: Date.now(),
      };
      await sendMessage(API, chatId, `✅ Bukti kamu sudah diterima.\nKode verifikasi: <code>${code}</code>\nTunggu admin menyetujuinya.`);
      for (const adminId of ADMIN_IDS) {
        await sendMessage(API, adminId, 
          `💰 Bukti pembayaran dari ${formatUser(from)}\nKode: ${code}\nGunakan /approve ${userId} atau /reject ${userId}.`
        );
      }
      return;
    }

    // Jika user kirim kode lisensi
    if (/^LS-[A-Z0-9-]+$/i.test(text)) {
      const lic = globalThis.LIC.LICENSES[userId];
      if (lic && lic.code === text) {
        await sendMessage(API, chatId, `✅ Lisensimu aktif sampai ${new Date(lic.exp).toLocaleString()}.`);
      } else {
        await sendMessage(API, chatId, `❌ Kode tidak valid atau belum disetujui.`);
      }
      return;
    }

    // Admin commands
    if (text.startsWith("/")) {
      const parts = text.split(" ");
      const cmd = parts[0].toLowerCase();
      const targetId = parseInt(parts[1]);

      // 🔒 Batasi hanya admin
      if (!isAdmin) {
        await sendMessage(API, chatId, "❌ Kamu bukan admin!");
        return;
      }

      switch (cmd) {
        case "/pending":
          if (Object.keys(globalThis.LIC.PENDING).length === 0)
            return await sendMessage(API, chatId, "Tidak ada pembayaran pending.");
          let list = "📋 Pending pembayaran:\n";
          for (const p of Object.values(globalThis.LIC.PENDING)) {
            list += `User ${p.username || p.userId} - kode ${p.code}\n`;
          }
          await sendMessage(API, chatId, list);
          return;

        case "/approve":
          if (!targetId) return await sendMessage(API, chatId, "Gunakan: /approve <user_id>");
          const pend = globalThis.LIC.PENDING[targetId];
          if (!pend) return await sendMessage(API, chatId, "User ini tidak ada di daftar pending.");
          globalThis.LIC.LICENSES[targetId] = { 
            code: pend.code, 
            exp: Date.now() + LICENSE_VALID_DAYS * MS_IN_DAY,
            groups: [],
          };
          delete globalThis.LIC.PENDING[targetId];
          await sendMessage(API, chatId, `✅ User ${targetId} disetujui.`);
          await sendMessage(API, targetId, 
            `✅ Lisensi kamu disetujui!\nKode: <code>${globalThis.LIC.LICENSES[targetId].code}</code>\nBerlaku sampai ${new Date(globalThis.LIC.LICENSES[targetId].exp).toLocaleString()}`
          );
          return;

        case "/reject":
          if (!targetId) return await sendMessage(API, chatId, "Gunakan: /reject <user_id>");
          delete globalThis.LIC.PENDING[targetId];
          await sendMessage(API, chatId, `❌ User ${targetId} ditolak.`);
          await sendMessage(API, targetId, `❌ Pembayaran kamu ditolak. Hubungi admin.`);
          return;

        case "/licenses":
          if (Object.keys(globalThis.LIC.LICENSES).length === 0)
            return await sendMessage(API, chatId, "Tidak ada lisensi aktif.");
          let msg = "💼 Lisensi aktif:\n";
          for (const [id, l] of Object.entries(globalThis.LIC.LICENSES)) {
            msg += `User ${id} - exp: ${new Date(l.exp).toLocaleString()}\n`;
          }
          await sendMessage(API, chatId, msg);
          return;

        default:
          await sendMessage(API, chatId, "📘 Perintah admin:\n/pending\n/approve <id>\n/reject <id>\n/licenses");
          return;
      }
    }
  }

  // --- Jika di grup ---
  if (msg.new_chat_members) {
    for (const member of msg.new_chat_members) {
      if (member.is_bot) continue;
      const photoCount = await getProfilePhotoCount(API, member.id);
      let info = `👋 ${member.first_name} bergabung.\nFoto profil: ${photoCount}`;
      await sendMessage(API, chatId, info);
      if (photoCount === 0) {
        await sendMessage(API, chatId, `⚠️ ${member.first_name} belum punya foto profil.`);
      }
    }
  }
}

// ------------------ Utility ------------------

function generateLicenseCode() {
  const a = () => Math.random().toString(36).substring(2, 8).toUpperCase();
  return `LS-${a()}-${Math.floor(1000 + Math.random()*9000)}`;
}

async function sendMessage(API, chatId, text) {
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

async function sendPhoto(API, chatId, url, caption = "") {
  await fetch(`${API}/sendPhoto`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: url, caption }),
  });
}

async function getProfilePhotoCount(API, userId) {
  try {
    const res = await fetch(`${API}/getUserProfilePhotos?user_id=${userId}&limit=1`);
    const data = await res.json();
    return data.ok ? data.result.total_count || 0 : 0;
  } catch {
    return 0;
  }
}

function formatUser(u) {
  return u.username ? `@${u.username}` : `${u.first_name} (${u.id})`;
  }
