const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const readline = require("readline");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const fse = require("fs-extra");
const SESSIONS_ROOT = "./sessions";
const BACKUP_ROOT = "./backup";
const DELAY_ROOT = "./delay_403";
const activeSockets = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pendingAutoReply = new Set();
const repliedUsers = new Set();
const store = {
    chats: {},
    bind: function () {}
};
const logErrorToFile = (label, error) => {
    const logLine = `[${new Date().toISOString()}] ${label}: ${error?.stack || error}\n`;
    fs.appendFileSync("error_audit.log", logLine);
};

let currentDate = null;
let schedule = null;
let broadcastInterval = null;
let modeHapusAktif = false;
let sedangMenungguKonfirmasi = false;
let totalBerhasilHapus = 0;
let totalGagalHapus = 0;
let refreshSudahAktif = false;
let heartbeatSudahAktif = false;

process.on("uncaughtException", (err) => {
    console.log("⚠️ Uncaught Exception:", err.message);
    logErrorToFile("UncaughtException", err);
});
process.on("unhandledRejection", (reason, promise) => {
    console.log("⚠️ Unhandled Rejection:", reason);
    logErrorToFile("UnhandledRejection", reason);
});

function showMainMenu() {
    console.log("\n==== STATUS SESSION ====");

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
    console.log("2. Cek Status Batch Session");
    console.log("3. Ambil ID Grup untuk Broadcast Otomatis");
    console.log("4. Mulai Kirim Pesan Pakai ID Grup")
    console.log("5. Kirim Pesan ke Diri Sendiri");
    console.log("6. Hapus Pesan untuk Semua Orang");
    console.log("7. Pindahkan Session ke/dari Backup");
    console.log("8. Ganti Nama File Session");
    console.log("9. Hapus Session");
    console.log("0. Keluar");

    rl.question("Pilih menu: ", async (choiceRaw) => {
        const choice = choiceRaw.trim();
    
        if (choice === "1") {
            loginSessionBaru();
        } else if (choice === "2") {
            await autoLoginSemuaSession(10);
            aktifkanHeartbeatSocket();
            jadwalkanRefreshOtomatis();
            showMainMenu();   
        } else if (choice === "3") {
            await jalankanPemilihanGrupBroadcast();
            showMainMenu();         
        } else if (choice === "4") {
            startAutoBroadcastFromFile();
        } else if (choice === "5") {
            await menuKirimPesanKeDiriSendiriMultiSession();
        } else if (choice === "6") {
            modeHapusAktif = true;
            await hapusSemuaPesanPribadiMultiSession();
            modeHapusAktif = false;
        } else if (choice === "7") {
            pindahkanSession();
        } else if (choice === "8") {
            await menuGantiNamaFolderSession();     
        } else if (choice === "9") {
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
                    sock.state = sock.state || {};
                    sock.state.connection = "open";

                    if (!sock?.user?.id) {
                        console.log("⚠️ Login gagal: user ID tidak tersedia.");
                        return resolve();
                    }

                    const fullId = sock.user.id;
                    const nomor = fullId.split(":")[0];

                    if (!activeSockets.find(s => s.id === fullId)) {
                        activeSockets.push({ name: nomor, sock, id: fullId, folder: path.basename(sessionPath) });
                    }

                    store.bind(sock.ev, sock, fullId);

                    if (showLog) {
                        console.log(`✅ Bot tersambung sebagai ${fullId}`);
                    }

                    resolve();
                    if (!silent && showLog) showMainMenu();
                }

                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    const sessionId = sock?.user?.id;
                
                    const isFatal =
                        reason === DisconnectReason.badSession ||
                        reason === DisconnectReason.loggedOut ||
                        reason === 403 ||
                        reason === 405;
                
                    if (isFatal && sessionId) {
                        const sessionName = path.basename(sessionPath);
                        const nomor = sessionId.split(":")[0];
                        const index = activeSockets.findIndex(s => s.id === sessionId);
                        if (index !== -1) activeSockets.splice(index, 1);

                        if (reason === 403) {
                            const delayFolder = "./delay_403";
                            const targetPath = path.join(delayFolder, sessionName);
                            if (!fs.existsSync(delayFolder)) fs.mkdirSync(delayFolder);
                
                            try {
                                fs.renameSync(sessionPath, targetPath);
                                console.log(`⏳ Session '${sessionName}' dipindahkan ke folder 'delay_403' karena reason 403.`);
                            } catch (err) {
                                console.log(`⚠️ Gagal pindahkan session '${sessionName}' ke 'delay_403': ${err.message}`);
                            }
                
                            return resolve();
                        }

                        try {
                            fs.rmSync(sessionPath, { recursive: true, force: true });
                            const fatalPath = "fatal.txt";
                            const line = `${new Date().toISOString()} | ${nomor} | reason ${reason}\n`;
                            fs.appendFileSync(fatalPath, line);
                
                            if (showLog) {
                                console.log(`🗑️ Session '${sessionName}' dihapus karena disconnect fatal (${reason}).`);
                                console.log(`📝 Nomor '${nomor}' dicatat ke fatal.txt`);
                            }
                        } catch (err) {
                            if (showLog) {
                                console.log(`⚠️ Gagal hapus session '${sessionName}':`, err.message);
                            }
                        }
                
                        resolve();
                        if (!silent && showLog) showMainMenu();
                        return;
                    }

                    if (sessionId) {
                        const index = activeSockets.findIndex(s => s.id === sessionId);
                        if (index !== -1) {
                            try {
                                activeSockets[index].sock.ev.removeAllListeners();
                            } catch {}
                            activeSockets.splice(index, 1);
                        }
                    }
                
                    startBot(sessionPath, silent, showLog);
                }
            });

        } catch (e) {
            if (showLog) {
                console.log("❌ Gagal login:", e.message);
            }
            resolve();
            if (!silent && showLog) showMainMenu();
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

function generateRandomSchedule(maxPerDay = 100) {
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


function isSocketReady(sock) {
    return (
        sock &&
        typeof sock.sendMessage === "function" &&
        typeof sock.user?.id === "string" &&
        ["open", "connecting"].includes(sock.state?.connection)
    );
}

async function startAutoBroadcastFromFile() {
    const filePath = "group_id.txt";
    if (!fs.existsSync(filePath)) {
        console.log("⚠️ Belum ada grup yang disimpan. Silakan pilih dulu.");
        return showMainMenu();
    }

    const groupIds = fs.readFileSync(filePath, "utf-8")
        .split("\n")
        .map(line => line.trim().toLowerCase())
        .filter(id => id.length > 0);

    if (groupIds.length === 0) {
        console.log("⚠️ Tidak ada ID grup tersimpan.");
        return showMainMenu();
    }

    const now = new Date();
    const today = now.toDateString();
    if (currentDate !== today) {
        currentDate = today;
        schedule = generateRandomSchedule();
    }

    console.log("\n📅 Jadwal kirim pesan hari ini:", schedule);
    console.log("\n==== DAFTAR GRUP BROADCAST ====");

    const sampleSock = activeSockets.find(s => isSocketReady(s.sock))?.sock;
    for (const gid of groupIds) {
        let namaGrup = "(tidak bisa ambil nama)";
        if (sampleSock) {
            try {
                const metadata = await sampleSock.groupMetadata(gid);
                namaGrup = metadata.subject;
            } catch (err) {
                console.log(`⚠️ Gagal ambil metadata grup ${gid}: ${err.message}`);
            }
        }
        console.log(`[+] ${gid} → ${namaGrup}`);
    }

    console.log("\n🚀 Tes kirim manual ke nomor pribadi...");
    try {
        const testSock = activeSockets.find(s => isSocketReady(s.sock));
        if (testSock) {
            await testSock.sock.sendMessage(testSock.id, { text: "tes ke diri sendiri" });
            console.log("✅ Tes kirim berhasil");
        } else {
            console.log("⚠️ Tidak ada socket aktif untuk tes.");
        }
    } catch (e) {
        console.log("❌ Tes kirim gagal:", e.message);
    }

    console.log("\n🚀 Mengirim pesan langsung pertama ke semua grup...");
    const validSockets = activeSockets.filter(s => isSocketReady(s.sock));
    for (const akun of validSockets) {
        for (const groupId of groupIds) {
            try {
                const metadata = await akun.sock.groupMetadata(groupId);
                console.log(`👥 Peserta grup '${metadata.subject}':`);
                metadata.participants?.forEach(p => console.log(`- ${p.id}`));

                const akunIdCek = akun.sock?.user?.id;
                const isKomunitas = groupId.endsWith("@lid");
                const isAnggota = metadata.participants?.some(p => p.id === akunIdCek);

                console.log(`🔍 ID akun: ${akunIdCek}`);
                if (!isAnggota && !isKomunitas) {
                    console.log(`⛔ ${akun.name} bukan anggota grup '${metadata.subject}', dilewati.`);
                    continue;
                }

                console.log(`➡️ Proses grup ${groupId} untuk akun ${akun.name}`);
                await kirimSalamKeGrup(akun.sock, groupId, akun.name);
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
                console.log(`⚠️ Gagal proses grup ${groupId} untuk ${akun.name}: ${err.message}`);
            }
        }
    }

    showMainMenu();

    setInterval(async () => {
        try {
            const now = new Date();
            const nowDate = now.toDateString();
            const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

            if (nowDate !== currentDate && now.getHours() === 6) {
                currentDate = nowDate;
                schedule = generateRandomSchedule();
                console.log("📅 Jadwal baru untuk", currentDate, ":", schedule);
            }

            if (!schedule || !schedule.includes(currentTime)) return;

            const validSockets = activeSockets.filter(s => isSocketReady(s.sock));
            if (validSockets.length === 0) {
                console.log("⚠️ Tidak ada socket siap. Lewati siklus ini.");
                return;
            }

            console.log(`⏳ Waktu cocok (${currentTime}). Menunggu socket siap...`);
            await new Promise(resolve => setTimeout(resolve, 3000));

            for (const akun of validSockets) {
                for (const groupId of groupIds) {
                    try {
                        const metadata = await akun.sock.groupMetadata(groupId);
                        console.log(`👥 Peserta grup '${metadata.subject}':`);
                        metadata.participants?.forEach(p => console.log(`- ${p.id}`));

                        const akunIdCek = akun.sock?.user?.id;
                        const isKomunitas = groupId.endsWith("@lid");
                        const isAnggota = metadata.participants?.some(p => p.id === akunIdCek);

                        console.log(`🔍 ID akun: ${akunIdCek}`);
                        if (!isAnggota && !isKomunitas) {
                            console.log(`⛔ ${akun.name} bukan anggota grup '${metadata.subject}', dilewati.`);
                            continue;
                        }

                        console.log(`➡️ Proses grup ${groupId} untuk akun ${akun.name}`);
                        await kirimSalamKeGrup(akun.sock, groupId, akun.name);
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } catch (err) {
                        console.log(`⚠️ Gagal proses grup ${groupId} untuk ${akun.name}: ${err.message}`);
                    }
                }
            }
        } catch (err) {
            console.log("⚠️ Error di siklus broadcast:", err.message);
        }
    }, 60 * 1000);
}

async function kirimSalamKeGrup(sock, groupId, name) {
    if (!sock?.user || typeof sock?.sendMessage !== "function") {
        console.log(`⚠️ Socket ${name} tidak valid atau belum siap, dilewati.`);
        return;
    }

    const salam = getSalamByJam();

    try {
        const metadata = await sock.groupMetadata(groupId);
        const namaGrup = metadata?.subject || groupId;
        const akunId = sock.user.id;
        const isKomunitas = groupId.endsWith("@lid");

        console.log(`👥 Peserta grup '${namaGrup}':`);
        metadata.participants?.forEach(p => console.log(`- ${p.id}`));
        console.log(`🔍 ID akun: ${akunId}`);

        if (!isKomunitas) {
            const participants = metadata.participants?.map(p => p.id) || [];
            const isMember = participants.includes(akunId);
            if (!isMember) {
                console.log(`⛔ ${name} bukan anggota grup '${namaGrup}', dilewati.`);
                return;
            }
            await sock.assertSessions(participants);
        }

        await sock.sendMessage(groupId, { text: salam });
        console.log(`✅ ${salam}, pesan terkirim oleh ${name} ke grup '${namaGrup}'`);

    } catch (err) {
        console.log(`❌ Gagal kirim ke grup '${groupId}' oleh ${name}: ${err.message}`);
    }
}

async function jalankanPemilihanGrupBroadcast() {
    const grupMap = new Map();

    for (const akun of activeSockets) {
        try {
            const grups = await akun.sock.groupFetchAllParticipating();
            const list = Object.values(grups);

            console.log(`🔍 Ambil grup dari ${akun.name}, total: ${list.length}`);

            for (const g of list) {
                if (!grupMap.has(g.id)) {
                    grupMap.set(g.id, g);

                    const isKomunitas = g.id.endsWith("@lid");
                    const isAktif = !g.announce && g.participants?.length > 0;

                    if (isAktif || isKomunitas) {
                        console.log(`✅ Grup aktif: ${g.subject}`);
                    } else {
                        console.log(`⚠️ Grup '${g.subject}' mungkin tidak bisa dikirim (announce mode atau kosong)`);
                    }
                }
            }
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

function aktifkanHeartbeatSocket() {
    if (heartbeatSudahAktif) return;
    heartbeatSudahAktif = true;

    setInterval(() => {
        for (const akun of activeSockets) {
            try {
                if (akun.sock?.user?.id && typeof akun.sock.sendPresenceUpdate === "function") {
                    akun.sock.sendPresenceUpdate("available");
                }
            } catch (err) {
                console.log(`⚠️ Heartbeat gagal untuk ${akun.name}: ${err.message}`);
            }
        }
    }, 60 * 1000);
}

async function safeSend(sock, jid, pesan, akunName, index) {
    const maxRetry = 5;
    let attempt = 0;

    while (attempt < maxRetry) {
        try {
            if (!pesan || typeof pesan !== "string" || pesan.trim().length === 0) {
                console.log(`⚠️ [${akunName} ${index}] Pesan kosong atau tidak valid. Lewatkan.`);
                return false;
            }

            const isValidSession =
                typeof sock?.sendMessage === "function" &&
                typeof sock?.user?.id === "string" &&
                sock?.ev;

            if (!isValidSession) {
                console.log(`⚠️ [${akunName} ${index}] Socket tidak valid. Lewatkan.`);
                return false;
            }

            try {
                await sock.assertSessions([jid]);
            } catch (sessionErr) {
                console.log(`⚠️ [${akunName} ${index}] Session tidak valid: ${sessionErr.message}`);
                return false;
            }

            await sock.sendPresenceUpdate("available");
            await sock.presenceSubscribe(jid);
            await new Promise(resolve => setTimeout(resolve, 500));

            await sock.sendMessage(jid, { text: pesan });
            return true;

        } catch (err) {
            attempt++;

            const isTimeout = err?.output?.statusCode === 408 || err?.message?.includes("Timed Out");
            const isConnClosed = err?.message?.includes("Connection Closed") || err?.message?.includes("close");
            const waitMs = isTimeout || isConnClosed ? 30000 : 10000;

            console.log(`⚠️ [${akunName} ${index}] Gagal kirim (percobaan ${attempt}): ${err.message}`);

            if (sock?.state?.connection !== "open" && typeof sock?.ev?.emit === "function") {
                try {
                    sock.ev.emit("connection.update", { connection: "connecting" });
                    console.log(`🔄 [${akunName}] Emit reconnect attempt...`);
                } catch (reconnectErr) {
                    console.log(`⚠️ [${akunName}] Gagal emit reconnect: ${reconnectErr.message}`);
                }
            }

            if (attempt < maxRetry) {
                console.log(`⏳ Menunggu ${Math.floor(waitMs / 1000)} detik sebelum retry...`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            } else {
                console.log(`❌ [${akunName} ${index}] Gagal total setelah ${maxRetry} percobaan.`);
                return false;
            }
        }
    }
}

async function menuKirimPesanKeDiriSendiriMultiSession() {
    console.log("\n==== KIRIM PESAN KE DIRI SENDIRI ====");

    const filePath = "pesan_harian.txt";
    if (!fs.existsSync(filePath)) {
        console.log("❌ File 'pesan_harian.txt' tidak ditemukan.");
        return showMainMenu();
    }

    const validSockets = activeSockets.filter(s =>
        s.sock &&
        typeof s.sock.sendMessage === "function" &&
        typeof s.sock.user?.id === "string" &&
        ["open", "connecting"].includes(s.sock.state?.connection)
    );

    if (validSockets.length === 0) {
        console.log("❌ Tidak ada session aktif atau socket belum siap.");
        console.log("🧪 Audit koneksi per session:");
        activeSockets.forEach((s, i) => {
            console.log(`  ${i + 1}. ${s.name} → ${s.sock?.state?.connection || "unknown"}`);
        });
        return showMainMenu();
    }

    const sessionAwal = [...validSockets];
    const totalSessionAwal = sessionAwal.length;

    while (true) {
        const lines = fs.readFileSync(filePath, "utf-8")
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (lines.length === 0) {
            console.log("⚠️ File 'pesan_harian.txt' kosong.");
            return showMainMenu();
        }

        const totalPesan = lines.length;
        const shuffledPesan = [...lines].sort(() => Math.random() - 0.5);

        const startTime = Date.now();

        for (let i = 0; i < totalPesan; i++) {
            const minDelayMinutes = 10;
            const maxDelayMinutes = 17;
            const delayMinutes = Math.floor(Math.random() * (maxDelayMinutes - minDelayMinutes + 1)) + minDelayMinutes;
            const delaySeconds = Math.floor(Math.random() * 60);
            const delayMs = (delayMinutes * 60000) + (delaySeconds * 1000);

            console.log(`\nSession Awal ${totalSessionAwal} Delay Pesan [${i + 1}] => ${delayMinutes} menit ${delaySeconds} detik`);

            let nomorUrut = 1;

            await Promise.all(sessionAwal.map(async (akun) => {
                const jid = akun.sock.user.id;
                const pesanIndex = (i + nomorUrut - 1) % totalPesan;
                const pesan = shuffledPesan[pesanIndex];

                try {
                    const sukses = await safeSend(akun.sock, jid, pesan, akun.name, i + 1);
                    if (sukses) {
                        const now = new Date();
                        const waktu = `${String(now.getHours()).padStart(2, "0")}.${String(now.getMinutes()).padStart(2, "0")}.${String(now.getSeconds()).padStart(2, "0")}`;
                        console.log(`✅ [${nomorUrut}]-[${akun.name}] ${pesan} — ${waktu}`);
                    }
                } catch (err) {
                    console.log(`❌ [${nomorUrut}]-[${akun.name}] Gagal: ${err.message}`);
                }

                nomorUrut++;
            }));

            console.log("──────────────────────────────────────────────────────────────────────");
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        const endTime = Date.now();
        const durasiMs = endTime - startTime;
        const menit = Math.floor(durasiMs / 60000);
        const detik = Math.floor((durasiMs % 60000) / 1000);

        console.log(`⏱️ Durasi siklus: ${menit} menit ${detik} detik`);
        console.log("🔁 Semua pesan sudah dikirim. Mengulang siklus baru...\n");
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

                const chat = store.chats[akunId][jid];
                chat.messages.push(msg);
                if (chat.messages.length > 100) {
                    chat.messages.shift();
                }

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

async function pindahkanSession() {
    if (!fs.existsSync(SESSIONS_ROOT)) fs.mkdirSync(SESSIONS_ROOT);
    if (!fs.existsSync(BACKUP_ROOT)) fs.mkdirSync(BACKUP_ROOT);
    if (!fs.existsSync(DELAY_ROOT)) fs.mkdirSync(DELAY_ROOT);

    console.log("\n==== PINDAHKAN SESSION ====");
    console.log("1. Pindahkan dari sessions → backup");
    console.log("2. Pindahkan dari backup → sessions");
    console.log("3. Pindahkan dari sessions → delay_403");
    console.log("4. Pindahkan dari delay_403 → sessions");

    rl.question("Pilih opsi: ", async (opsi) => {
        let asalRoot = "";
        let tujuanRoot = "";

        if (opsi === "1") {
            asalRoot = SESSIONS_ROOT;
            tujuanRoot = BACKUP_ROOT;
        } else if (opsi === "2") {
            asalRoot = BACKUP_ROOT;
            tujuanRoot = SESSIONS_ROOT;
        } else if (opsi === "3") {
            asalRoot = SESSIONS_ROOT;
            tujuanRoot = DELAY_ROOT;
        } else if (opsi === "4") {
            asalRoot = DELAY_ROOT;
            tujuanRoot = SESSIONS_ROOT;
        } else {
            console.log("⚠️ Pilihan tidak valid.");
            return showMainMenu();
        }

        const daftar = fs.readdirSync(asalRoot).filter(f =>
            fs.lstatSync(path.join(asalRoot, f)).isDirectory()
        );

        if (daftar.length === 0) {
            console.log(`⚠️ Tidak ada session di folder ${path.basename(asalRoot)}.`);
            return showMainMenu();
        }

        console.log(`\nSession yang tersedia di ${path.basename(asalRoot)}:`);
        daftar.forEach((f, i) => console.log(`${i + 1}. ${f}`));
        console.log("ALL. Pindahkan semua session");

        rl.question("Pilih session yang ingin dipindahkan: ", async (ans) => {
            let indices = [];
            let pindahkanSemua = false;

            if (ans.toLowerCase() === "all") {
                pindahkanSemua = true;
                indices = daftar.map((_, i) => i);
            } else {
                indices = ans.split(",")
                    .map(x => parseInt(x.trim()) - 1)
                    .filter(i => !isNaN(i) && i >= 0 && i < daftar.length);
            }

            if (indices.length === 0) {
                console.log("⚠️ Pilihan tidak valid.");
                return showMainMenu();
            }

            const sessionsDipindahkan = [];

            for (const index of indices) {
                const nama = daftar[index];
                const asal = path.join(asalRoot, nama);
                const tujuan = path.join(tujuanRoot, nama);

                if (asalRoot === SESSIONS_ROOT) {
                    const aktif = activeSockets.find(s => s.id.startsWith(nama));
                    if (aktif) {
                        try {
                            aktif.sock.ev.removeAllListeners();
                            aktif.sock.end();
                        } catch {}
                        const i = activeSockets.findIndex(s => s.id === aktif.id);
                        if (i !== -1) activeSockets.splice(i, 1);
                    }
                }

                try {
                    fs.renameSync(asal, tujuan);
                    console.log(`✅ Session '${nama}' dipindahkan ke ${path.basename(tujuanRoot)}.`);
                    sessionsDipindahkan.push(nama);
                } catch (err) {
                    console.log(`❌ Gagal memindahkan '${nama}': ${err.message}`);
                }
            }

            if (tujuanRoot === SESSIONS_ROOT) {
                const semuaFolder = fs.readdirSync(SESSIONS_ROOT).filter(f =>
                    fs.lstatSync(path.join(SESSIONS_ROOT, f)).isDirectory()
                );

                console.log(`📦 Meload ulang semua session di folder 'sessions' (${semuaFolder.length} total)...`);

                for (const folder of semuaFolder) {
                    const sessionPath = path.join(SESSIONS_ROOT, folder);
                    const sudahAktif = activeSockets.find(s => s.folder === folder);
                    if (!sudahAktif) {
                        await startBot(sessionPath, true, false);
                    }
                }

                deduplicateSessions();
            }

            console.log(`📊 Total session dipindahkan: ${sessionsDipindahkan.length}`);
            console.log(`📊 Total session aktif sekarang: ${activeSockets.length}`);

            showMainMenu();
        });
    });
}

function ask(question) {
    return new Promise(resolve => {
        rl.question(question, answer => {
            resolve(answer.trim());
        });
    });
}

async function menuGantiNamaFolderSession() {
    console.log("\n==== GANTI NAMA FOLDER SESSION ====");

    const sessionRoot = "./sessions";
    if (!fs.existsSync(sessionRoot)) {
        console.log("❌ Folder 'sessions' tidak ditemukan.");
        return showMainMenu();
    }

    const folders = fs.readdirSync(sessionRoot).filter(name => {
        const fullPath = path.join(sessionRoot, name);
        return fs.lstatSync(fullPath).isDirectory();
    });

    if (folders.length === 0) {
        console.log("⚠️ Tidak ada folder session yang tersedia.");
        return showMainMenu();
    }

    console.log("📁 Folder session yang tersedia:");
    folders.forEach((folder, idx) => {
        console.log(`${idx + 1}. ${folder}`);
    });

    const pilih = await ask("Pilih nomor folder yang ingin diganti: ");
    const index = parseInt(pilih.trim(), 10) - 1;
    if (isNaN(index) || index < 0 || index >= folders.length) {
        console.log("❌ Pilihan tidak valid.");
        return showMainMenu();
    }

    const oldFolder = folders[index];
    const newFolderRaw = await ask("Masukkan nama folder baru: ");
    const newFolder = newFolderRaw.trim();

    if (!newFolder || newFolder.includes("/") || newFolder.includes("\\") || newFolder.includes("..")) {
        console.log("❌ Nama folder tidak valid.");
        return showMainMenu();
    }

    const oldPath = path.join(sessionRoot, oldFolder);
    const newPath = path.join(sessionRoot, newFolder);

    if (fs.existsSync(newPath)) {
        console.log("⚠️ Folder dengan nama baru sudah ada. Gagal mengganti.");
        return showMainMenu();
    }

    try {
        fs.renameSync(oldPath, newPath);
        console.log(`✅ Berhasil mengganti '${oldFolder}' menjadi '${newFolder}'`);
    } catch (err) {
        console.log(`❌ Gagal mengganti folder: ${err.message}`);
    }

    showMainMenu();
}

function hapusSession() {
    const ROOTS = {
        "1": { label: "sessions", path: SESSIONS_ROOT },
        "2": { label: "backup", path: BACKUP_ROOT },
        "3": { label: "delay_403", path: DELAY_ROOT }
    };    

    console.log("\n==== PILIH FOLDER UNTUK HAPUS SESSION ====");
    console.log("1. sessions");
    console.log("2. backup");
    console.log("3. delay_403");

    rl.question("Pilih folder sumber: ", (folderChoice) => {
        const root = ROOTS[folderChoice];
        if (!root) {
            console.log("⚠️ Pilihan folder tidak valid.");
            return showMainMenu();
        }

        if (!fs.existsSync(root.path)) {
            console.log(`⚠️ Folder '${root.label}' belum ada.`);
            return showMainMenu();
        }

        const folders = fs.readdirSync(root.path).filter(f =>
            fs.lstatSync(path.join(root.path, f)).isDirectory()
        );

        if (folders.length === 0) {
            console.log(`⚠️ Tidak ada session di folder '${root.label}' untuk dihapus.`);
            return showMainMenu();
        }

        console.log(`\n==== HAPUS SESSION DARI '${root.label}' ====`);
        folders.forEach((f, i) => {
            console.log(`${i + 1}. ${f}`);
        });
        console.log("ALL. Hapus semua session");

        rl.question("Pilih session yang ingin dihapus: ", (ans) => {
            let indices = [];
            let hapusSemua = false;

            if (ans.toLowerCase() === "all") {
                hapusSemua = true;
                indices = folders.map((_, i) => i);
            } else {
                indices = ans.split(",")
                    .map(x => parseInt(x.trim()) - 1)
                    .filter(i => !isNaN(i) && i >= 0 && i < folders.length);
            }

            if (indices.length === 0) {
                console.log("⚠️ Pilihan tidak valid.");
                return showMainMenu();
            }

            const target = hapusSemua ? folders : indices.map(i => folders[i]);
            console.log("\n📂 Session yang akan dihapus:");
            target.forEach(n => console.log(`- ${n}`));

            rl.question("Yakin hapus? (y/n): ", (confirm) => {
                if (confirm.toLowerCase() !== "y") {
                    console.log("❌ Dibatalkan, tidak ada session dihapus.");
                    return showMainMenu();
                }

                let totalHapus = 0;
                for (const nama of target) {
                    const dir = path.join(root.path, nama);
                    try {
                        fs.rmSync(dir, { recursive: true, force: true });
                        console.log(`✅ Session '${nama}' dihapus dari '${root.label}'.`);
                        totalHapus++;

                        if (root.label === "sessions") {
                            const idx = activeSockets.findIndex(s => s.name === nama || s.id.startsWith(nama));
                            if (idx !== -1) {
                                try { activeSockets[idx].sock.ev.removeAllListeners(); } catch {}
                                activeSockets.splice(idx, 1);
                            }
                        }
                    } catch (err) {
                        console.log(`❌ Gagal hapus '${nama}': ${err.message}`);
                    }
                }

                console.log(`📊 Total session dihapus: ${totalHapus}`);
                showMainMenu();
            });
        });
    });
}

async function autoLoginSemuaSession(batchSize = 10) {
    if (!fs.existsSync(SESSIONS_ROOT)) return;

    const folders = fs.readdirSync(SESSIONS_ROOT)
        .filter(f => fs.lstatSync(path.join(SESSIONS_ROOT, f)).isDirectory());

    if (folders.length === 0) {
        console.log("⚠️ Tidak ada session tersimpan.");
        return;
    }

    console.log(`🔍 Total session ditemukan: ${folders.length}`);
    const totalBatch = Math.ceil(folders.length / batchSize);

    for (let b = 0; b < totalBatch; b++) {
        const batchFolders = folders.slice(b * batchSize, (b + 1) * batchSize);
        console.log(`🚀 Memuat batch ${b + 1}/${totalBatch}: ${batchFolders.length} session`);

        const tasks = batchFolders.map(async (folder) => {
            const sessionPath = path.join(SESSIONS_ROOT, folder);
            const credsPath = path.join(sessionPath, "creds.json");

            if (!fs.existsSync(credsPath)) {
                try {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    console.log(`🗑️ Folder kosong '${folder}' dihapus (tidak ada creds.json).`);
                } catch (err) {
                    console.log(`⚠️ Gagal hapus folder '${folder}': ${err.message}`);
                }
                return;
            }

            const startTime = Date.now();
            try {
                await startBot(sessionPath, true, false);
                const endTime = Date.now();
                console.log(`✅ Session '${folder}' selesai dalam ${(endTime - startTime) / 1000}s`);
            } catch (err) {
                console.log(`❌ Gagal login session '${folder}': ${err.message}`);
            }
        });

        await Promise.all(tasks);

        console.log(`✅ Batch ${b + 1} selesai. Menunggu sebelum lanjut...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

function deduplicateSessions() {
    const grouped = new Map();

    for (const s of activeSockets) {
        if (!s?.id) continue;
        const nomor = s.id.split(":")[0];
        const instance = parseInt(s.id.split(":")[1]) || 0;

        if (!grouped.has(nomor)) {
            grouped.set(nomor, [s]);
        } else {
            grouped.get(nomor).push(s);
        }
    }

    for (const [nomor, sessions] of grouped.entries()) {
        if (sessions.length > 1) {
            sessions.sort((a, b) => {
                const ia = parseInt(a.id.split(":")[1]) || 0;
                const ib = parseInt(b.id.split(":")[1]) || 0;
                return ib - ia;
            });

            const keep = sessions[0];
            const remove = sessions.slice(1);

            for (const s of remove) {
                try {
                    s.sock?.ev.removeAllListeners();
                } catch {}
                const idx = activeSockets.findIndex(x => x.id === s.id);
                if (idx !== -1) activeSockets.splice(idx, 1);

                try {
                    const folderName = path.basename(s.sock?.authState?.credsPath || "");
                    const sessionPath = path.join(SESSIONS_ROOT, folderName || nomor);
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                } catch (err) {
                    console.log(`⚠️ Gagal hapus session '${s.id}': ${err.message}`);
                }
            }
        }
    }
}

function jadwalkanRefreshOtomatis() {
    if (refreshSudahAktif) return;
    refreshSudahAktif = true;

    const loop = () => {
        const min = 18;
        const max = 32;
        const delayMenit = Math.floor(Math.random() * (max - min + 1)) + min;
        const delayMs = delayMenit * 60 * 1000;

        const waktuSekarang = new Date();
        const waktuBerikutnya = new Date(waktuSekarang.getTime() + delayMs);
        const formatWaktu = waktuBerikutnya.toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit'
        });

        setTimeout(() => {
            try {
            } catch (err) {
                console.error(`[${new Date().toLocaleTimeString('id-ID')}] ❌ Gagal refresh:`, err);
            }

            loop();
        }, delayMs);
    };

    loop();
}

(async () => {
    try {
        showMainMenu();
    } catch (err) {
        console.error("❌ Gagal menjalankan bot:", err);
    }
})();