const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const readline = require("readline");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const logErrorToFile = (label, error) => {
    const logLine = `[${new Date().toISOString()}] ${label}: ${error?.stack || error}\n`;
    fs.appendFileSync("error_audit.log", logLine);
};
process.on("uncaughtException", (err) => {
    console.log("⚠️ Uncaught Exception:", err.message);
    logErrorToFile("UncaughtException", err);
});
process.on("unhandledRejection", (reason, promise) => {
    console.log("⚠️ Unhandled Rejection:", reason);
    logErrorToFile("UnhandledRejection", reason);
});

const SESSIONS_ROOT = "./sessions";
const activeSockets = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let currentDate = null;
let schedule = null;
let modeHapusAktif = false;
let sedangMenungguKonfirmasi = false;
let totalBerhasilHapus = 0;
let totalGagalHapus = 0;
const pendingAutoReply = new Set();
const repliedUsers = new Set();
const store = {
    chats: {},
    bind: function () {}
};

function showMainMenu() {
    console.log("\n\n==== STATUS SESSION ====");

    const sessionAktif = activeSockets.filter(s =>
        s.sock?.user &&
        typeof s.sock?.sendMessage === "function"
    );

    if (sessionAktif.length === 0) {
        console.log("⚠️ Tidak ada session aktif.");
    } else {
        sessionAktif.forEach((s, i) => {
            console.log(`✅ Session ${i + 1}: ${s.name} (${s.id})`);
        });
    }

    console.log("\n==== MENU UTAMA ====");
    console.log("1. Login / Tambah Session");
    console.log("2. Ambil ID Grup untuk Broadcast Otomatis");
    console.log("3. Mulai Kirim Pesan Pakai ID Grup")
    console.log("4. Hapus Pesan untuk Semua Orang");
    console.log("5. Hapus Session");
    console.log("0. Keluar");

    rl.question("Pilih menu: ", async (choiceRaw) => {
        const choice = choiceRaw.trim();
    
        if (choice === "1") {
            loginSessionBaru();
        } else if (choice === "2") {
            await jalankanPemilihanGrupBroadcast();
            showMainMenu();         
        } else if (choice === "3") {
            startAutoBroadcastFromFile();
            await kirimPesanAntarSession();
        } else if (choice === "4") {
            modeHapusAktif = true;
            await hapusSemuaPesanPribadiMultiSession();
            modeHapusAktif = false;
        } else if (choice === "5") {
            hapusSession();
        } else if (choice === "0") {
            console.log("Keluar...");
            process.exit(0);
        } else {
            showMainMenu();
        }
    });
}

function loginSessionBaru() {
    if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT);

    const folders = fs.readdirSync(SESSIONS_ROOT).filter(f => {
        const fullPath = path.join(SESSIONS_ROOT, f);
        return fs.lstatSync(fullPath).isDirectory();
    });

    console.log("\n==== LOGIN SESSION ====");
    if (folders.length > 0) {
        console.log("Pilih session untuk login ulang:");
        folders.forEach((f, i) => {
            console.log(`${i + 1}. ${f}`);
        });
    } else {
        console.log("Belum ada session tersimpan.");
    }

    console.log("Y. Tambah session baru");
    console.log("N. Kembali");

    rl.question("Pilih: ", (ans) => {
        if (ans.toLowerCase() === "n") return showMainMenu();

        if (ans.toLowerCase() === "y") {
            rl.question("Masukkan nomor WhatsApp (misal 628xxxxxx): ", (nomor) => {
                const sessionName = nomor.trim();
                if (!sessionName) {
                    console.log("⚠️ Nomor tidak boleh kosong.");
                    return loginSessionBaru();
                }

                const sessionPath = path.join(SESSIONS_ROOT, sessionName);
                if (!fs.existsSync(sessionPath)) {
                    fs.mkdirSync(sessionPath, { recursive: true });
                    console.log(`📁 Folder session dibuat: ${sessionPath}`);
                } else {
                    console.log(`📁 Menggunakan ulang session: ${sessionPath}`);
                }

                startBot(sessionPath, false, true);
            });
        } else {
            const index = parseInt(ans) - 1;
            if (folders[index]) {
                const sessionPath = path.join(SESSIONS_ROOT, folders[index]);
                startBot(sessionPath, false, true);
            } else {
                console.log("⚠️ Pilihan tidak valid.");
                loginSessionBaru();
            }
        }
    });
}

async function startBot(sessionPath, silent = false, showLog = true) {
    return new Promise(async (resolve) => {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const sock = makeWASocket({
                auth: state,
                logger: pino({ level: "silent" }),
            });

            sock.ev.on("creds.update", saveCreds);
            sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
                if (qr && !silent) {
                    console.log("🔹 Scan QR untuk login:");
                    qrcode.generate(qr, { small: true });
                }

                if (connection === "open") {
                    if (!sock?.user?.id) {
                        console.log("⚠️ Login gagal: user ID tidak tersedia.");
                        return resolve();
                    }

                    const fullId = sock.user.id;
                    const nomor = fullId.split(":")[0];

                    if (!activeSockets.find(s => s.id === fullId)) {
                        activeSockets.push({ name: nomor, sock, id: fullId });
                    }

                    if (showLog) {
                        console.log(`✅ Bot tersambung sebagai ${fullId}`);
                    }

                    resolve();
                    if (!silent) showMainMenu();
                }

                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    const sessionId = sock?.user?.id;
                
                    if (reason === DisconnectReason.timedOut) {
                        console.log(`⏱️ Session ${sock.user?.id || "unknown"} timeout, akan di-restart...`);
                        const index = activeSockets.findIndex(s => s.id === sock?.user?.id);
                        if (index !== -1) activeSockets.splice(index, 1);
                        startBot(sessionPath, silent, showLog);
                        return;
                    }
                
                    if (showLog) {
                        console.log(`🔌 Koneksi terputus: ${DisconnectReason[reason] || reason}`);
                    }
                
                    const isFatal =
                        reason === DisconnectReason.badSession ||
                        reason === DisconnectReason.loggedOut;
                
                    if (isFatal && sessionId) {
                        const index = activeSockets.findIndex(s => s.id === sessionId);
                        if (index !== -1) {
                            activeSockets.splice(index, 1);
                        }
                
                        try {
                            fs.rmSync(sessionPath, { recursive: true, force: true });
                            if (showLog) {
                                console.log(`🗑️ Session '${path.basename(sessionPath)}' dihapus karena disconnect fatal.`);
                            }
                        } catch (err) {
                            if (showLog) {
                                console.log(`⚠️ Gagal hapus session '${path.basename(sessionPath)}':`, err.message);
                            }
                        }
                
                        resolve();
                        if (!silent) showMainMenu();
                    } else {
                        if (showLog) {
                            console.log("🔄 Koneksi terputus, mencoba reconnect...");
                        }
                
                        // Hindari duplikasi socket saat reconnect
                        if (sessionId) {
                            const index = activeSockets.findIndex(s => s.id === sessionId);
                            if (index !== -1) {
                                activeSockets.splice(index, 1);
                            }
                        }
                
                        startBot(sessionPath, silent, showLog);
                    }
                }
            });

            sock.ev.on("messages.upsert", async ({ messages, type }) => {
                if (type !== "notify") return;

                for (const msg of messages) {
                    if (msg.key.fromMe && msg.key.remoteJid.endsWith("@s.whatsapp.net")) {
                        const log = {
                            remoteJid: msg.key.remoteJid,
                            id: msg.key.id,
                            timestamp: msg.messageTimestamp
                        };
                        fs.appendFileSync("pesan_terkirim.log", JSON.stringify(log) + "\n");
                    }
                }
            });

        } catch (e) {
            if (showLog) {
                console.log("❌ Gagal login:", e.message);
            }
            resolve();
            if (!silent) showMainMenu();
        }
    });
}

function getSalamByJam() {
    const now = new Date();
    const jam = now.getHours();

    if (jam >= 6 && jam <= 10) return "Selamat pagi";
    if (jam >= 11 && jam <= 14) return "Selamat siang";
    if (jam >= 15 && jam <= 17) return "Selamat sore";
    return "Selamat malam";
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function generateRandomSchedule(maxPerDay = 15) {
    const startHour = 6;
    const endHour = 23;
    const schedule = [];
    const usedHours = new Set();

    for (let hour = startHour; hour <= endHour; hour++) {
        const minute = Math.floor(Math.random() * 60);
        const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        schedule.push(timeStr);
        usedHours.add(hour);
    }

    while (schedule.length < maxPerDay) {
        const hour = Math.floor(Math.random() * (endHour - startHour + 1)) + startHour;
        const minute = Math.floor(Math.random() * 60);
        const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;

        if (!schedule.includes(timeStr)) {
            schedule.push(timeStr);
        }
    }

    return schedule.sort();
}

async function sudahJoinGrup(sock, groupId) {
    try {
        const grupAktif = await sock.groupFetchAllParticipating();
        return Object.keys(grupAktif).includes(groupId);
    } catch (err) {
        console.log(`⚠️ Gagal cek grup ${groupId}:`, err.message);
        return false;
    }
}

function startAutoBroadcastFromFile() {
    const filePath = "group_id.txt";
    if (!fs.existsSync(filePath)) {
        console.log("⚠️ Belum ada grup yang disimpan. Silakan pilih dulu.");
        return;
    }

    const groupIds = fs.readFileSync(filePath, "utf-8")
        .split("\n")
        .map(line => line.trim())
        .filter(id => id.length > 0);

    const now = new Date();
    const today = now.toDateString();

    if (currentDate !== today) {
        currentDate = today;
        schedule = generateRandomSchedule();
        console.log("📅 Jadwal kirim pesan hari ini:", schedule);
    }

    setInterval(async () => {
        const now = new Date();
        const nowDate = now.toDateString();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

        if (nowDate !== currentDate && now.getHours() === 6) {
            currentDate = nowDate;
            schedule = generateRandomSchedule();
            console.log("📅 Jadwal baru untuk", currentDate, ":", schedule);
        }

        if (!schedule || !schedule.includes(currentTime)) return;

        const validSockets = activeSockets.filter(s => !s.name.startsWith("temp_"));
        console.log("⏳ Menunggu socket siap...");
        await new Promise(resolve => setTimeout(resolve, 3000));

        for (const akun of validSockets) {
            // ✅ Tambahkan di sini
            if (!akun.sock?.ws || akun.sock.ws.readyState !== 1) {
                console.log(`⚠️ Socket ${akun.name} tidak siap, dilewati.`);
                continue;
            }
        
            for (const groupId of groupIds) {
                const tergabung = await sudahJoinGrup(akun.sock, groupId);
                if (!tergabung) {
                    console.log(`🚫 Akun ${akun.name} belum tergabung di grup ${groupId}, dilewati.`);
                    continue;
                }
        
                await kirimSalamKeGrup(akun.sock, groupId, akun.name);
                await new Promise(resolve => setTimeout(resolve, 500)); // delay antar grup
            }
        }
    }, 60 * 1000);
}

async function kirimSalamKeGrup(sock, groupId, name) {
    // 🔍 Validasi socket aktif
    if (!sock?.user || typeof sock?.sendMessage !== "function" || !sock?.ws || sock.ws.readyState !== 1) {
        console.log(`⚠️ Socket ${name} belum siap kirim pesan, dilewati.`);
        return;
    }

    // 🔍 Cek apakah tergabung di grup
    let tergabung = false;
    try {
        tergabung = await sudahJoinGrup(sock, groupId);
    } catch (err) {
        console.log(`⚠️ Gagal cek keikutsertaan grup untuk ${name}: ${err.message || err}`);
        return;
    }

    if (!tergabung) {
        let namaGrup = groupId;
        try {
            const metadata = await sock.groupMetadata(groupId);
            namaGrup = metadata.subject;
        } catch (e) {
            namaGrup = "❓(tidak bisa ambil nama)";
        }

        console.log(`🚫 Akun ${name} belum tergabung di grup '${namaGrup}', dilewati.`);
        return;
    }

    // 📝 Ambil salam berdasarkan jam
    const salam = getSalamByJam();

    // 📡 Kirim pesan ke grup
    try {
        let namaGrup = "";
        try {
            const metadata = await sock.groupMetadata(groupId);
            namaGrup = metadata.subject;
        } catch (e) {
            namaGrup = "❓(tidak bisa ambil nama)";
        }

        const pesan = { text: `${salam}` };
        await sock.sendMessage(groupId, pesan);

        console.log(`✅ ${salam}, pesan terkirim oleh ${name} ke grup '${namaGrup}'`);
    } catch (err) {
        const errorMessage = err?.message || err?.toString() || "Unknown error";
        console.log(`❌ Gagal kirim ke grup oleh ${name}: ${errorMessage}`);
        console.log(`⏭️ Error bukan fatal, session '${name}' tetap dipertahankan.`);
    }
}

async function jalankanPemilihanGrupBroadcast() {
    const grupMap = new Map();

    for (const akun of activeSockets) {
        try {
            const grups = await akun.sock.groupFetchAllParticipating();
            const list = Object.values(grups);

            for (const g of list) {
                if (!grupMap.has(g.id)) {
                    grupMap.set(g.id, g);
                }
            }

            console.log(`🔍 Ambil grup dari ${akun.name}, total: ${list.length}`);
        } catch (err) {
            console.log(`⚠️ Gagal ambil grup dari ${akun.name}:`, err.message);
        }
    }

    const semuaGrup = Array.from(grupMap.values());
    await pilihGrupDariSemuaSession(semuaGrup);
}

function pilihGrupDariSemuaSession(semuaGrup) {
    return new Promise((resolve) => {
        if (!Array.isArray(semuaGrup) || semuaGrup.length === 0) {
            console.log("⚠️ Tidak ada grup yang bisa dipilih.");
            return resolve(null);
        }

        console.log("\n==== PILIH GRUP DARI SEMUA SESSION ====");
        semuaGrup.forEach((g, i) => {
            console.log(`${i + 1}. ${g.subject}`);
        });

        rl.question("Pilih grup untuk ditambahkan ke daftar broadcast: ", (ans) => {
            const index = parseInt(ans) - 1;
            const selected = semuaGrup[index];

            if (selected) {
                const filePath = "group_id.txt";
                const newEntry = selected.id.trim().toLowerCase();

                let existingLines = [];
                if (fs.existsSync(filePath)) {
                    existingLines = fs.readFileSync(filePath, "utf-8")
                        .split("\n")
                        .map(line => line.trim().toLowerCase())
                        .filter(line => line.length > 0);
                }

                const alreadyExists = existingLines.includes(newEntry);
                if (!alreadyExists) {
                    existingLines.push(newEntry);
                    fs.writeFileSync(filePath, existingLines.join("\n"));
                    console.log(`✅ Grup '${selected.subject}' ditambahkan ke daftar broadcast.`);
                } else {
                    console.log(`ℹ️ Grup '${selected.subject}' sudah ada di daftar.`);
                }

                resolve(selected.id);
            } else {
                console.log("⚠️ Pilihan tidak valid.");
                resolve(null);
            }
        });
    });
}

async function kirimAutoReplyDanHapus(sock, akunId, jid) {
    try {
        const outboundMessages = store.chats[akunId][jid].messages.filter(m =>
            m.key.fromMe && m.message?.conversation !== "maaf salah nomor"
        );

        for (const m of outboundMessages) {
            try {
                await sock.sendMessage(jid, { delete: m.key });
                console.log(`🗑️ Dihapus oleh ${akunId}: ${jid} → "${m.message?.conversation || '[Media]'}"`);
                totalBerhasilHapus++;
            } catch (err) {
                console.log(`⚠️ Gagal hapus oleh ${akunId}: ${jid} → ${err.message || err}`);
                totalGagalHapus++;
            }
        }

        const sent = await sock.sendMessage(jid, { text: "maaf salah nomor" });
        console.log(`🤖 Auto-reply ke ${jid}: "maaf salah nomor"`);

        if (sent?.key) {
            store.chats[akunId][jid].messages.push(sent);
        }
    } catch (err) {
        console.log(`⚠️ Gagal auto-reply ke ${jid}:`, err.message || err);
    } finally {
        pendingAutoReply.delete(jid);

        if (pendingAutoReply.size === 0 && !sedangMenungguKonfirmasi) {
            console.log("\n✅ Selesai hapus pesan pribadi.");
            console.log(`📊 Total berhasil dihapus: ${totalBerhasilHapus}`);
            console.log(`📊 Total gagal dihapus: ${totalGagalHapus}`);
            console.log("✅ Semua auto-reply selesai. Kembali ke menu utama...");
            showMainMenu();
        }
    }
}

async function hapusSemuaPesanPribadiMultiSession() {
    sedangMenungguKonfirmasi = true;
    pendingAutoReply.clear();
    repliedUsers.clear();
    modeHapusAktif = true;
    isDeleting = true;

    const autoRepliedBeforeConfirm = new Set();

    for (const akun of activeSockets) {
        const akunId = akun.id;
        const sock = akun.sock;

        sock.ev.on("messages.upsert", async ({ messages }) => {
            for (let msg of messages) {
                const jid = msg.key.remoteJid;
                if (jid.endsWith("@g.us") || jid.endsWith("@broadcast")) continue;

                const isText = !!msg.message?.conversation;
                const isImage = !!msg.message?.imageMessage;
                if (!isText && !isImage) continue;

                if (!store.chats[akunId]) store.chats[akunId] = {};
                if (!store.chats[akunId][jid]) store.chats[akunId][jid] = { messages: [] };

                const exists = store.chats[akunId][jid].messages.some((m) => m.key.id === msg.key.id);
                if (exists) continue;

                store.chats[akunId][jid].messages.push(msg);

                if (!msg.key.fromMe && !repliedUsers.has(jid)) {
                    const outboundMessages = store.chats[akunId][jid].messages.filter(m =>
                        m.key.fromMe && m.message?.conversation !== "maaf salah nomor"
                    );
                    if (outboundMessages.length > 0) {
                        repliedUsers.add(jid);
                        autoRepliedBeforeConfirm.add(jid);
                        pendingAutoReply.add(jid);
                        await kirimAutoReplyDanHapus(sock, akunId, jid);
                    }
                }
            }
        });
    }

    console.log("⏳ Menunggu pesan masuk selama 3 detik...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log("🧪 Debug: Isi cache sebelum hapus:");
    for (const akun of activeSockets) {
        const akunId = akun.id;
        const akunChats = store.chats[akunId];
        const total = akunChats
            ? Object.values(akunChats).reduce((sum, chat) => sum + chat.messages.length, 0)
            : 0;

        console.log(`✅ ${akun.name} memiliki ${total} pesan tersimpan`);
    }

    rl.question("", async (input) => {
        if (input.trim().toLowerCase() === "y") {
            console.log("🔐 Konfirmasi diterima. Mulai hapus pesan dan auto-reply...");
            sedangMenungguKonfirmasi = false;

            let totalBerhasil = 0;
            let totalGagal = 0;

            for (const akun of activeSockets) {
                const akunId = akun.id;
                const sock = akun.sock;
                const akunChats = store.chats[akunId];
                if (!akunChats) continue;

                for (const jid of Object.keys(akunChats)) {
                    const chat = akunChats[jid];
                    const outboundMessages = chat.messages.filter(m =>
                        m.key.fromMe && m.message?.conversation !== "maaf salah nomor"
                    );
                    if (outboundMessages.length === 0 || repliedUsers.has(jid)) continue;
                
                    pendingAutoReply.add(jid);
                
                    if (autoRepliedBeforeConfirm.has(jid)) {
                        console.log(`⏭️ Lewatkan auto-reply ke ${jid} (sudah dibalas sebelum konfirmasi)`);
                        pendingAutoReply.delete(jid);
                        continue;
                    }
                
                    const delayMs = (Math.floor(Math.random() * (2 - 1 + 1)) + 1) * 60 * 1000;
                    console.log(`⏳ Akan auto-reply ke ${jid} dalam ${(delayMs / 60000).toFixed(1)} menit`);
                
                    setTimeout(async () => {
                        await kirimAutoReplyDanHapus(sock, akunId, jid, true);
                    }, delayMs);
                }
            }

            if (pendingAutoReply.size === 0) {
                console.log("✅ Tidak ada auto-reply tertunda. Kembali ke menu utama...");
                showMainMenu();
            }
        } else {
            sedangMenungguKonfirmasi = false;
            console.log("❌ Konfirmasi tidak diberikan. Kembali ke menu utama...");
            showMainMenu();
        }
    });
}

function hapusSession() {
    const folders = fs.readdirSync(SESSIONS_ROOT).filter(f => fs.lstatSync(path.join(SESSIONS_ROOT, f)).isDirectory());
    if (folders.length === 0) {
        console.log("⚠️ Tidak ada session untuk dihapus.");
        return showMainMenu();
    }

    console.log("\n==== HAPUS SESSION ====");
    folders.forEach((f, i) => {
        console.log(`${i + 1}. ${f}`);
    });
    console.log("B. Batal");

    rl.question("Pilih session yang ingin dihapus: ", (ans) => {
        if (ans.toLowerCase() === "b") return showMainMenu();
        const index = parseInt(ans) - 1;
        if (folders[index]) {
            const dir = path.join(SESSIONS_ROOT, folders[index]);
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`✅ Session '${folders[index]}' dihapus.`);
        } else {
            console.log("Pilihan tidak valid.");
        }
        showMainMenu();
    });
}

async function autoLoginSemuaSession() {
    if (!fs.existsSync(SESSIONS_ROOT)) return;

    const folders = fs.readdirSync(SESSIONS_ROOT).filter(f => {
        const fullPath = path.join(SESSIONS_ROOT, f);
        return fs.lstatSync(fullPath).isDirectory();
    });

    for (const folder of folders) {
        const sessionPath = path.join(SESSIONS_ROOT, folder);
        const credsPath = path.join(sessionPath, "creds.json");

        if (!fs.existsSync(credsPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`🗑️ Folder kosong '${folder}' dihapus (tidak ada creds.json).`);
            } catch (err) {
                console.log(`⚠️ Gagal hapus folder '${folder}':`, err.message);
            }
            continue;
        }

        await startBot(sessionPath, true, false);
    }
}

function jadwalkanRefreshOtomatis() {
    const min = 18;
    const max = 32;
    const delayMenit = Math.floor(Math.random() * (max - min + 1)) + min;
    const delayMs = delayMenit * 60 * 1000;

    setTimeout(() => {
        jadwalkanRefreshOtomatis();
    }, delayMs);
}

(async () => {
    await autoLoginSemuaSession();
    showMainMenu();
    jadwalkanRefreshOtomatis();
})();