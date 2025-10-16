export default {
  async fetch(request, env) {
    const TOKEN = "7522192709:AAFDwX-Lng-_3FUtr6oAiFu-nfD_XLMCsd8";
    const ADMIN_ID = 7729648778;
    const API = `https://api.telegram.org/bot${TOKEN}`;
    const WARN_LIMIT = 3;

    // Penyimpanan sementara (reset jika worker restart)
    if (!globalThis.warns) globalThis.warns = {};

    if (request.method === "POST") {
      const update = await request.json();
      const msg = update.message;

      if (!msg) return new Response("No message");

      const chatId = msg.chat.id;
      const from = msg.from;
      const text = msg.text || "";

      // 🧩 1. Deteksi anggota baru
      if (msg.new_chat_members) {
        for (const member of msg.new_chat_members) {
          // Abaikan bot
          if (member.is_bot) continue;

          // Jika yang menambahkan adalah admin → jangan kick
          if (msg.from && (await isAdmin(API, chatId, msg.from.id))) {
            await sendMessage(API, chatId, `✅ ${member.first_name} ditambahkan oleh admin.`);
            await sendMessage(API, ADMIN_ID, `ℹ️ ${member.first_name} ditambahkan oleh admin. Aman.`);
            continue;
          }

          // Cek foto profil
          const photos = await fetch(`${API}/getUserProfilePhotos?user_id=${member.id}`).then(r => r.json());
          const photoCount = photos.ok ? photos.result.total_count : 0;

          const username = member.username ? `@${member.username}` : "(tidak ada)";
          const name = member.first_name || "Tanpa Nama";

          let profileInfo = `👤 <b>Anggota Baru</b>\nNama: ${name}\nUsername: ${username}\nID: <code>${member.id}</code>\nFoto Profil: ${photoCount}`;
          await sendMessage(API, chatId, profileInfo);

          // Jika tidak ada foto → kasih peringatan
          if (photoCount === 0) {
            const key = `${chatId}:${member.id}`;
            globalThis.warns[key] = (globalThis.warns[key] || 0) + 1;
            const warnCount = globalThis.warns[key];

            if (warnCount >= WARN_LIMIT) {
              await fetch(`${API}/kickChatMember`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, user_id: member.id }),
              });
              await sendMessage(API, chatId, `🚫 ${name} (${username}) dikeluarkan karena tidak punya foto profil.`);
              await sendMessage(API, ADMIN_ID, `🚨 ${name} (${username}) dikeluarkan otomatis setelah ${warnCount} peringatan.`);
              delete globalThis.warns[key];
            } else {
              await sendMessage(API, chatId, `⚠️ ${name}, kamu belum punya foto profil. Peringatan ke-${warnCount}/${WARN_LIMIT}.`);
              await sendMessage(API, ADMIN_ID, `⚠️ ${name} (${username}) tidak punya foto profil. Peringatan ${warnCount}/${WARN_LIMIT}.`);
            }
          } else {
            await sendMessage(API, chatId, `👋 Selamat datang, ${name}!`);
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
