const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const readline = require("readline");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const SESSIONS_ROOT = "./sessions";
let SESSION_DIR = "";
const activeSockets = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function showMainMenu() {
    console.log("\n==== STATUS SESSION ====");

    if (activeSockets.length === 0) {
        console.log("⚠️ Belum ada session aktif.");
    } else {
        activeSockets.forEach((s, i) => {
            console.log(`✅ Session ${i + 1}: ${s.name} (${s.id})`);
        });
    }

    console.log("\n==== MENU UTAMA ====");
    console.log("1. Login / Tambah Session");
    console.log("2. Mulai Kirim Pesan Antar Akun");
    console.log("3. Hapus Session");
    console.log("0. Keluar");

    rl.question("Pilih menu: ", async (choice) => {
        if (choice === "1") {
            loginSessionBaru();
        } else if (choice === "2") {
            await kirimPesanAntarSession();
            showMainMenu();
        } else if (choice === "3") {
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
            rl.question("Masukkan nomor WhatsApp (mis. 628xxxxxx): ", (nomor) => {
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

            sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
                if (qr && !silent) {
                    console.log("🔹 Scan QR untuk login:");
                    qrcode.generate(qr, { small: true });
                }

                if (connection === "open") {
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
                
                    const isFatal =
                        reason === DisconnectReason.badSession ||
                        reason === DisconnectReason.loggedOut ||
                        reason === DisconnectReason.connectionClosed;
                
                    if (isFatal) {
                        const index = activeSockets.findIndex(s => s.id === sock?.user?.id);
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
                        startBot(sessionPath, silent, showLog);
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

function generateUniquePairs(sessions) {
    const pairs = [];
    for (let i = 0; i < sessions.length; i++) {
        for (let j = i + 1; j < sessions.length; j++) {
            pairs.push([sessions[i], sessions[j]]);
        }
    }
    return pairs;
}

async function kirimPesanAntarSession() {
    const validSockets = activeSockets.filter(s => !s.name.startsWith("temp_"));

    if (validSockets.length < 2) {
        console.log("⚠️ Minimal dua akun final harus login untuk kirim pesan.");
        return;
    }

    const pairs = generateUniquePairs(validSockets);
    for (const [akunA, akunB] of pairs) {
        console.log(`💬 Memulai percakapan antara ${akunA.name} dan ${akunB.name}`);
        await kirimPercakapanBerpasangan(akunA.sock, akunB.sock, akunA.id, akunB.id);
    }

    console.log("✅ Semua percakapan selesai.");
}

const dialogOpeners = [
    "Hai! Kamu lagi sibuk nggak?",
    "Aku baru nemu lagu enak banget.",
    "Lagi kepikiran liburan nih...",
    "Kamu suka kopi atau teh?",
    "Baru aja selesai baca buku bagus.",
    "Lagi pengen ngobrol aja sih.",
    "Kamu pernah ke Jogja?",
    "Weekend ini ada rencana?",
    "Lagi belajar coding nih, kamu?",
    "Kamu suka film action nggak?"
];

const dialogReplies = [
    "Wah, aku juga lagi santai nih.",
    "Serius? Share dong judulnya!",
    "Liburan ke mana tuh rencananya?",
    "Aku tim kopi sih, kamu?",
    "Buku apa tuh? Aku suka baca juga.",
    "Ngobrol aja yuk, aku juga butuh teman cerita.",
    "Jogja tuh vibes-nya beda ya.",
    "Belum ada sih, kamu ada ide?",
    "Coding itu seru tapi bikin pusing 😅",
    "Suka banget! Terutama yang ada plot twist."
];

function loadDialogLines(filePath) {
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        return content.split("\n").map(line => line.trim()).filter(line => line.length > 0);
    } catch (err) {
        console.log(`⚠️ Gagal baca file '${filePath}':`, err.message);
        return [];
    }
}

async function kirimPercakapanBerpasangan(sockA, sockB, idA, idB) {
    const namaA = idA.split('@')[0];
    const namaB = idB.split('@')[0];
    const logFileA = path.join(SESSIONS_ROOT, namaA, "audit.log");
    const logFileB = path.join(SESSIONS_ROOT, namaB, "audit.log");

    const openers = loadDialogLines("dialogOpeners.txt");
    const replies = loadDialogLines("dialogReplies.txt");

    if (openers.length === 0 || replies.length === 0) {
        console.log("⚠️ File dialog kosong atau tidak ditemukan.");
        return;
    }

    const totalRounds = 5;
    for (let i = 0; i < totalRounds; i++) {
        const pesanA = openers[Math.floor(Math.random() * openers.length)];
        const balasanB = replies[Math.floor(Math.random() * replies.length)];

        try {
            if (!sockA?.user || !sockB?.user) {
                console.log(`⚠️ Salah satu akun (${namaA} atau ${namaB}) tidak aktif. Lewati.`);
                break;
            }

            await sockA.sendMessage(idB, { text: pesanA });
            fs.appendFileSync(logFileA, `[${new Date().toISOString()}] ${namaA} → ${namaB}: ${pesanA}\n`);
            console.log(`👤 ${namaA} → ${namaB}: ${pesanA}`);
            await sleep(5000 + Math.random() * 5000);

            await sockB.sendMessage(idA, { text: balasanB });
            fs.appendFileSync(logFileB, `[${new Date().toISOString()}] ${namaB} → ${namaA}: ${balasanB}\n`);
            console.log(`👤 ${namaB} → ${namaA}: ${balasanB}`);
            await sleep(5000 + Math.random() * 5000);

        } catch (err) {
            console.log(`❌ Gagal kirim pesan antara ${namaA} dan ${namaB}:`, err.message);
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

(async () => {
    await autoLoginSemuaSession();
    showMainMenu();
})();