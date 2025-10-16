export default {
  async fetch(request, env) {
    // ⚠️ Ganti token ini dengan token bot kamu sendiri
    const TOKEN = "7522192709:AAFDwX-Lng-_3FUtr6oAiFu-nfD_XLMCsd8";
    const ADMIN_ID = 7729648778; // ID admin atau grup laporan
    const url = `https://api.telegram.org/bot${TOKEN}`;

    // Kata terlarang dan pola link mencurigakan
    const bannedWords = ["porno", "sex", "http://", "https://", "t.me/", "joinchat"];
    const warnings = {}; // penyimpanan sementara per user

    if (request.method === "POST") {
      const update = await request.json();
      const msg = update.message;
      if (!msg || !msg.chat) return new Response("No message");

      const chatId = msg.chat.id;
      const text = msg.text ? msg.text.toLowerCase() : "";
      const user = msg.from;
      const userId = user.id;
      const username = user.username ? `@${user.username}` : user.first_name;

      // --- [1] Deteksi kata terlarang / spam ---
      for (const word of bannedWords) {
        if (text.includes(word)) {
          await fetch(`${url}/deleteMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: msg.message_id }),
          });

          // Tambah peringatan
          warnings[userId] = (warnings[userId] || 0) + 1;
          const warnCount = warnings[userId];

          if (warnCount >= 3) {
            // Ban otomatis
            await fetch(`${url}/kickChatMember`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, user_id: userId }),
            });
            await sendMessage(url, chatId, `🚫 ${username} dibanned otomatis (3x peringatan).`);
            await sendMessage(url, ADMIN_ID, `🚨 ${username} dibanned dari grup ${chatId}`);
            delete warnings[userId];
          } else {
            await sendMessage(url, chatId, `⚠️ ${username}, peringatan ke-${warnCount}.`);
            await sendMessage(url, ADMIN_ID, `⚠️ ${username} mengirim konten terlarang (warn ${warnCount}).`);
          }
          return new Response("Warned");
        }
      }

      // --- [2] Perintah admin manual ---
      if (text.startsWith("/")) {
        const parts = text.split(" ");
        const command = parts[0];
        const target = parts[1];

        const adminActions = {
          "/ban": "kickChatMember",
          "/mute": "restrictChatMember",
          "/unban": "unbanChatMember",
        };

        if (adminActions[command]) {
          const action = adminActions[command];
          const payload = { chat_id: chatId, user_id: parseInt(target) || userId };
          if (command === "/mute") payload.permissions = { can_send_messages: false };

          await fetch(`${url}/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });

          await sendMessage(url, chatId, `✅ ${command.replace("/", "")} ${target} berhasil.`);
          await sendMessage(url, ADMIN_ID, `🛠 Admin menjalankan ${command} terhadap ${target}`);
          return new Response("Command done");
        }
      }

      // --- [3] Deteksi anggota baru ---
      if (msg.new_chat_members) {
        for (const member of msg.new_chat_members) {
          if (!member.is_bot && !member.photo) {
            await fetch(`${url}/kickChatMember`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, user_id: member.id }),
            });
            await sendMessage(url, chatId, `🚫 ${member.first_name} dikeluarkan (tidak ada foto profil).`);
            await sendMessage(url, ADMIN_ID, `👤 ${member.first_name} dikeluarkan otomatis (no photo).`);
          }
        }
      }

      return new Response("OK");
    }

    return new Response("Bot Satpam Sakti v2 aktif ✅");
  },
};

async function sendMessage(url, chatId, text) {
  await fetch(`${url}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
                }
