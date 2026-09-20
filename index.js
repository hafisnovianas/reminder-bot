// Zona waktu WAJIB dipaksa sebelum modul lain sempat membuat objek Date.
// Server (mis. AWS) default-nya UTC, sedangkan seluruh logika jadwal bot ini
// memakai jam lokal (setHours, toLocaleString). Tanpa baris ini "besok jam 8"
// tersimpan sebagai 08:00 UTC alias 15:00 WIB. Bisa ditimpa lewat env TZ.
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

// Cegah libsignal mencetak private key sesi WhatsApp ke log (lihat modulnya).
require('./lib/quiet-libsignal').redamLogSesi();

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { mulaiAutoBackup, jalankanBackupDatabase } = require('./lib/auto-backup');

// Modul SQLite
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// Semua ambang & nomor admin kini datang dari environment (lihat lib/config.js)
const {
    ADMIN_JID,
    DB_PATH,
    SIMPAN_RIWAYAT_HARI,
    SPAM_THRESHOLD,
    SPAM_WINDOW_MS,
    MAX_REMINDER_PER_USER,
    MAX_KIRIM_PER_PUTARAN,
    JEDA_KIRIM_MS,
    SESI_KEDALUWARSA_MS
} = require('./lib/config');

let sock; // Variabel global untuk socket WA
let db;   // Variabel global untuk koneksi database SQLite

// Penjaga agar tidak ada dua proses penyambungan berjalan bersamaan.
// Event 'close' bisa muncul berkali-kali untuk satu kegagalan yang sama;
// tanpa penjaga ini setiap event menjadwalkan connectToWhatsApp() sendiri,
// socket lama tidak pernah dibersihkan, dan satu pesan user berakhir diproses
// oleh beberapa listener sekaligus (balasan dobel, jadwal tersimpan dobel).
let sedangMenghubungkan = false;
let percobaanUlang = 0;

// Map memori sementara untuk melacak alur tanya-jawab user
const userSessions = new Map();

// Map untuk rate limiting (Anti-Spam)
const rateLimitMap = new Map();

const tidur = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Penanganan error global agar bot tidak mati (Down)
process.on('uncaughtException', (err) => {
    console.error('💥 [CRITICAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Penerjemah waktu pintar (lihat lib/parse-time.js, diuji di test/parser.test.js)
const { parseSmartTime } = require('./lib/parse-time');

// Penerjemah pesan AI berbasis Groq
const { parseJadwalWithAI } = require('./lib/ai-parser');

// Penjadwalan ulang pengingat berulang (diuji di test/recurrence.test.js)
const { hitungJadwalBerikutnya } = require('./lib/recurrence');

// Format tanggal panjang untuk pesan konfirmasi
function formatWaktuLengkap(date) {
    return date.toLocaleString('id-ID', {
        weekday: 'long', year: 'numeric', month: 'long',
        day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

// Format ringkas untuk daftar pilihan jam ambigu: "07:00, Senin 24 Agustus"
function formatWaktuRingkas(date) {
    const jam = date.toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const hari = date.toLocaleString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
    return `${jam}, ${hari}`;
}

// Setelah waktu final ditentukan, lanjut ke pertanyaan pengulangan.
// Dipakai baik dari alur normal maupun setelah user memilih jam yang ambigu.
async function lanjutKeTahapPesan(pengirim, session, targetDate) {
    session.waktuEksekusi = targetDate.getTime();
    session.konfirmasiWaktu = formatWaktuLengkap(targetDate);
    session.step = 'WAITING_MESSAGE';
    delete session.pilihanWaktu;

    await sock.sendMessage(pengirim, {
        text: `🗓️ Waktu diatur pada: *${session.konfirmasiWaktu}*\n\nSekarang, apa pesan pengingat yang ingin disampaikan?\n_(Contoh: "Bayar SPP anak" atau ketik *b* untuk batal)_`
    });
}

// ========================================================
async function initDatabase() {
    // Path absolut (lihat lib/config.js) agar tidak bergantung cwd pm2
    db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database
    });
    console.log(`🗄️  Database: ${DB_PATH}`);

    // Membuat tabel 'users' untuk melacak siapa saja yang sudah menyimpan kontak
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            nomor_wa TEXT PRIMARY KEY,
            nama TEXT,
            is_registered INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    `);

    // Membuat tabel 'reminders' jika belum ada
    await db.exec(`
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nomor_wa TEXT NOT NULL,
            pesan TEXT NOT NULL,
            waktu_eksekusi INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL
        )
    `);

    // Membuat tabel 'feedbacks' untuk menampung saran/laporan user
    await db.exec(`
        CREATE TABLE IF NOT EXISTS feedbacks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nomor_wa TEXT NOT NULL,
            nama TEXT NOT NULL,
            pesan TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);

    // Tambahkan kolom tipe_pengulangan (Abaikan error jika kolom sudah ada)
    try {
        await db.exec(`ALTER TABLE reminders ADD COLUMN tipe_pengulangan TEXT DEFAULT 'sekali'`);
    } catch (e) {}

    // Tambahkan kolom snooze_count untuk Auto-Snooze
    try {
        await db.exec(`ALTER TABLE reminders ADD COLUMN snooze_count INTEGER DEFAULT 0`);
    } catch (e) {}

    // Index untuk dua query yang paling sering jalan: cron tiap menit mencari
    // jadwal jatuh tempo, dan tiap user membuka daftar jadwalnya sendiri.
    // Tanpa ini SQLite memindai seluruh tabel setiap 60 detik.
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_jatuh_tempo ON reminders (status, waktu_eksekusi)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_per_user ON reminders (nomor_wa, status, waktu_eksekusi)`);

    console.log('📦 Database SQLite siap dan tabel telah diperiksa.');
}

/** Jadwalkan sambung ulang dengan jeda yang makin panjang (maks 60 detik). */
function jadwalkanSambungUlang() {
    const jeda = Math.min(60000, 2000 * Math.pow(2, percobaanUlang));
    percobaanUlang += 1;
    console.log(`🔄 Menghubungkan ulang dalam ${Math.round(jeda / 1000)} detik (percobaan ke-${percobaanUlang})...`);
    setTimeout(connectToWhatsApp, jeda);
}

async function connectToWhatsApp() {
    if (sedangMenghubungkan) return;
    sedangMenghubungkan = true;

    // Putuskan socket lama sebelum membuat yang baru, supaya listener-nya tidak
    // ikut hidup dan memproses pesan yang sama untuk kedua kalinya.
    if (sock) {
        const socketLama = sock;
        sock = null;
        try {
            // Urutannya penting: lepas listener DULU. sock.end() memicu event
            // 'connection.update' bertipe close, dan kalau handler-nya masih
            // terpasang, dia akan menjadwalkan sambung ulang untuk kedua kalinya.
            socketLama.ev.removeAllListeners();
            // end() mengembalikan Promise; tanpa .catch penolakannya lolos dari
            // try/catch ini dan mendarat di handler unhandledRejection.
            Promise.resolve(socketLama.end(undefined)).catch(() => {});
        } catch (e) {
            // Socket lama memang sudah mati, tidak masalah.
        }
    }

    let state;
    let saveCreds;
    let version;
    try {
        ({ state, saveCreds } = await useMultiFileAuthState('auth_wa'));
        const info = await fetchLatestBaileysVersion();
        version = info.version;
        console.log(`📱 Menggunakan WA v${info.version.join('.')}, isLatest: ${info.isLatest}`);
    } catch (e) {
        // Gagal sebelum socket sempat dibuat (mis. jaringan mati saat ambil
        // versi). Tanpa ini flag sedangMenghubungkan tersangkut selamanya dan
        // bot tidak pernah mencoba menyambung lagi.
        console.error('❌ Gagal menyiapkan koneksi:', e?.message || e);
        sedangMenghubungkan = false;
        jadwalkanSambungUlang();
        return;
    }

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), 
        browser: ['Ubuntu', 'Chrome', '20.0.04'] 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
            console.log('🟢 Silakan scan QR Code di bawah ini:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;

            console.log(`❌ Koneksi terputus. Kode Status: ${reason}`);

            // Lepas penjaga DULU, baru jadwalkan. Kalau tidak, percobaan
            // berikutnya akan langsung ditolak oleh guard di awal fungsi.
            sedangMenghubungkan = false;

            if (shouldReconnect) {
                jadwalkanSambungUlang();
            } else {
                console.log('🛑 Sesi Logout. Folder auth_wa sudah tidak valid, silakan hapus folder tersebut dan restart server.');
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Berhasil Terhubung! Bot Reminder Siap!');
            sedangMenghubungkan = false;
            percobaanUlang = 0; // koneksi sehat, reset jeda backoff
            mulaiAutoBackup(sock, db);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        // Hanya pesan yang benar-benar baru. Saat reconnect, Baileys mengirim
        // ulang riwayat lama dengan type 'append' — tanpa cek ini bot membalas
        // chat basi dan bisa membuat ulang jadwal yang sudah lama selesai.
        if (m.type !== 'notify') return;

        // Satu batch bisa berisi lebih dari satu pesan. Versi lama hanya
        // mengambil m.messages[0], sehingga pesan lain dalam batch yang sama
        // hilang tanpa jejak ketika beberapa pesan tiba berbarengan.
        for (const msg of m.messages) {
            try {
                await tanganiPesan(msg);
            } catch (e) {
                console.error('❌ Error tak terduga saat memproses pesan:', e);
            }
        }
    });

    /**
     * Tangani SATU pesan masuk. Semua `return` di dalamnya berarti "selesai
     * dengan pesan ini", bukan menghentikan sisa batch.
     */
    async function tanganiPesan(msg) {
        if (!msg?.message || msg.key.fromMe) return;

        const asalChat = msg.key.remoteJid || '';

        // Bot ini dirancang untuk percakapan pribadi satu lawan satu.
        // Tanpa filter ini bot ikut menyahut di grup dan mengirim kartu kontak
        // ke sana, serta membalas setiap update status yang lewat.
        if (
            asalChat.endsWith('@g.us') ||          // grup
            asalChat.endsWith('@broadcast') ||     // termasuk status@broadcast
            asalChat.endsWith('@newsletter')       // channel
        ) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        const pengirim = msg.key.remoteJidAlt || msg.key.remoteJid;

        // 🌟 MENGAMBIL NAMA PENGIRIM DARI PROFIL WA MEREKA
        const namaPengirim = msg.pushName || 'Kak'; 

        if (!text) return;

        const waktuSekarang = new Date().getTime();

        // ==========================================
        // 🛡️ FITUR ANTI-SPAM (RATE LIMITING)
        // ==========================================
        if (!rateLimitMap.has(pengirim)) {
            rateLimitMap.set(pengirim, { count: 1, firstMessageTime: waktuSekarang, warned: false });
        } else {
            const userSpamData = rateLimitMap.get(pengirim);
            if (waktuSekarang - userSpamData.firstMessageTime < SPAM_WINDOW_MS) {
                userSpamData.count += 1;
                if (userSpamData.count > SPAM_THRESHOLD) {
                    if (!userSpamData.warned) {
                        userSpamData.warned = true;
                        try {
                            await sock.sendMessage(pengirim, { text: `⚠️ *Sistem Anti-Spam Aktif*\nAnda mengirim terlalu banyak pesan dalam waktu singkat. Bot akan mengabaikan pesan Anda sementara. Harap tunggu beberapa saat.` });
                        } catch (e) { console.log('Gagal mengirim peringatan spam'); }
                    }
                    return; // Hentikan eksekusi, abaikan pesan user ini
                }
            } else {
                // Reset karena sudah lewat window time
                rateLimitMap.set(pengirim, { count: 1, firstMessageTime: waktuSekarang, warned: false });
            }
        }
        // ==========================================

        try {
            // 1. Cek apakah user sudah terdaftar di tabel users
            const user = await db.get(`SELECT * FROM users WHERE nomor_wa = ?`, [pengirim]);

            // 2. Jika user belum ada atau belum registrasi (is_registered = 0)
            if (!user || user.is_registered === 0) {
                if (text.toUpperCase().trim() === 'SUDAH') {
                    if (!user) {
                        await db.run(`INSERT INTO users (nomor_wa, nama, is_registered, created_at) VALUES (?, ?, 1, ?)`, [pengirim, namaPengirim, waktuSekarang]);
                    } else {
                        await db.run(`UPDATE users SET is_registered = 1, nama = ? WHERE nomor_wa = ?`, [namaPengirim, pengirim]);
                    }
                    
                    await sock.sendMessage(pengirim, { 
                        text: `🎉 *Selamat bergabung, ${namaPengirim}!*\n\nNomor Anda telah terdaftar. Anda bisa membuat pengingat baru cukup dengan mengetik pesan Anda secara natural.\n\nContoh: _"Nanti malam jam 8 ingatkan saya minum obat"_\n\nKetik *p* atau *panduan* kapan saja untuk melihat fitur lengkapnya.` 
                    });
                    console.log(`👤 User baru terverifikasi: ${namaPengirim} (${pengirim})`);
                    return; 
                } 
                else {
                    const botNumber = sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : '';
                    
                    const vcard = 'BEGIN:VCARD\n'
                                + 'VERSION:3.0\n'
                                + 'FN:Bot Reminder\n' 
                                + 'ORG:Layanan Asisten Pribadi;\n' 
                                + `TEL;type=CELL;type=VOICE;waid=${botNumber}:+${botNumber}\n` 
                                + 'END:VCARD';

                    await sock.sendMessage(pengirim, {
                        text: `👋 *Halo ${namaPengirim}! Saya adalah Bot Pengingat (Reminder).*\n\nAgar pesan pengingat nantinya tidak telat atau masuk ke folder SPAM oleh sistem WhatsApp, silakan *Simpan Kartu Kontak* di bawah ini terlebih dahulu.\n\nJika sudah disimpan, balas pesan ini dengan mengetik *SUDAH* (atau cukup balas huruf *s*).`
                    });

                    await sock.sendMessage(pengirim, {
                        contacts: {
                            displayName: 'Bot Reminder',
                            contacts: [{ vcard }]
                        }
                    });

                    if (!user) {
                        await db.run(`INSERT INTO users (nomor_wa, nama, is_registered, created_at) VALUES (?, ?, 0, ?)`, [pengirim, namaPengirim, waktuSekarang]);
                    }
                    return; 
                }
            }

            const userText = text.trim();
            const lowerText = userText.toLowerCase();

            // 1. CEK FITUR PEMBATALAN (batal, b, atau 0)
            if (lowerText === 'batal' || lowerText === 'b' || lowerText === '0') {
                if (userSessions.has(pengirim)) {
                    userSessions.delete(pengirim);
                    await sock.sendMessage(pengirim, { text: `✅ Aksi telah dibatalkan.` });
                }
                return;
            }

            // 2. CEK STATUS ALUR PERCAKAPAN SAAT INI
            let session = userSessions.get(pengirim);

            // Sesi yang ditinggalkan user akan dilupakan. Tanpa ini, orang yang
            // mengetik *i* lalu pergi akan tersangkut di langkah itu selamanya:
            // sapaan biasa keesokan harinya langsung dikira isi pengingat.
            if (session && waktuSekarang - (session.terakhirAktif || 0) > SESI_KEDALUWARSA_MS) {
                userSessions.delete(pengirim);
                session = undefined;
                await sock.sendMessage(pengirim, {
                    text: `⏳ Sesi sebelumnya sudah kedaluwarsa karena terlalu lama tidak dilanjutkan.\n\nKetik *i* (atau *ingatkan*) untuk memulai lagi dari awal.`
                });
                return;
            }

            if (session) session.terakhirAktif = waktuSekarang;

            if (session) {
                // TAHAP 2: Bot sedang menunggu input Pesan (Setelah Waktu ditangkap)
                if (session.step === 'WAITING_MESSAGE') {
                    // Batasi panjang pesan maksimal 300 karakter untuk mencegah database bloat
                    if (userText.length > 300) {
                        await sock.sendMessage(pengirim, { text: `⚠️ *Pesan Terlalu Panjang!*\nMaksimal pesan adalah 300 karakter. Pesan Anda mengandung ${userText.length} karakter.\n\nSilakan ketik ulang pesannya dengan lebih singkat. _(Ketik *b* untuk batal)_` });
                        return;
                    }

                    session.pesan = userText;          
                    session.step = 'WAITING_RECURRENCE';     
                    
                    await sock.sendMessage(pengirim, { 
                        text: `🗓️ Jadwal: *${session.konfirmasiWaktu}*\n📝 Pesan: "${session.pesan}"\n\nApakah pengingat ini perlu diulang rutin?\nBalas dengan angka:\n*1* = Tidak (Hanya sekali)\n*2* = Ya, Setiap Hari\n*3* = Ya, Setiap Minggu (Di hari yang sama)\n*4* = Ya, Setiap Bulan (Di tanggal yang sama)\n*5* = Ya, Setiap Tahun (Di tanggal dan bulan yang sama)\n\n_(Ketik *b* untuk membatalkan)_`
                    });
                    return;
                }
                
                // TAHAP 1: Bot sedang menunggu input Waktu
                else if (session.step === 'WAITING_TIME') {
                    if (lowerText === 'panduan' || lowerText === 'p') {
                        await sock.sendMessage(pengirim, { 
                            text: `💡 *Panduan Bot Reminder*\n\n*⌨️ Daftar Perintah Cepat:*\n• *i* (atau *ingatkan*) : Buat jadwal baru\n• *j* (atau *jadwal*) : Lihat daftar jadwal\n• *h 1* (atau *hapus 1*) : Hapus jadwal No. 1\n• *hs* (atau *hapus semua*) : Hapus semua\n• *saran* (atau *lapor*) : Kirim masukan/bug\n• *b* (atau *batal*) : Batal membuat jadwal\n• *p* (atau *panduan*) : Buka menu bantuan\n\n*⏱️ Cara Mengetik Waktu:*\n• Durasi: *5 menit* (atau 5 mnt), *2 jam*, *3 hari*\n• Hari ini: *14:30*, *jam 7 pagi*, *hari ini 07.00*, *nanti malam jam 8*\n• Besok/Lusa: *besok 08:00*, *besok pagi*, *lusa 3 sore*\n• Nama hari: *senin 3 sore*, *jumat jam 8 malam*\n• Spesifik (Tgl/Bln/Thn Jam:Menit): *25/08/2026 09:00*\n\n_Santai saja, kalimat biasa juga dimengerti — contoh: "buat besok pagi jam 7"._\n\nSilakan balas waktu kapan Anda ingin diingatkan.\n_(Atau ketik *b* untuk batal)_` 
                        });
                        return; // Jangan hapus sesi, biarkan user balas lagi
                    }

                    const hasilWaktu = parseSmartTime(userText);

                    if (!hasilWaktu) {
                        await sock.sendMessage(pengirim, {
                            text: `❌ *Format waktu tidak dikenali!*\n\nKetik *p* (atau *panduan*) untuk melihat contoh pengetikan yang benar, atau ketik *b* (atau *batal*) untuk membatalkan.`
                        });
                        return;
                    }

                    // Jam polos seperti "jam 7" bisa berarti pagi atau malam.
                    // Tanyakan dulu daripada menebak diam-diam.
                    if (hasilWaktu.type === 'ambiguous') {
                        session.pilihanWaktu = hasilWaktu.candidates.map(d => d.getTime());
                        session.step = 'WAITING_TIME_CLARIFY';

                        const daftar = hasilWaktu.candidates
                            .map((d, i) => `*${i + 1}* = ${formatWaktuRingkas(d)}`)
                            .join('\n');

                        await sock.sendMessage(pengirim, {
                            text: `🕐 *"${userText}"* bisa berarti dua waktu. Maksud Anda yang mana?\n\n${daftar}\n\n_(Balas dengan angkanya. Lain kali bisa langsung tulis *jam 7 pagi* atau *19:00* agar tidak ditanya lagi.)_\n❌ Ketik *b* untuk batal.`
                        });
                        return;
                    }

                    const targetDate = hasilWaktu.date;

                    if (targetDate.getTime() <= waktuSekarang) {
                        await sock.sendMessage(pengirim, { text: `❌ *Waktu sudah berlalu!* Masukkan waktu di masa depan.\n_(Atau ketik *b* untuk batal)_` });
                        return;
                    }

                    // Pindah ke tahap tanya Pesan
                    await lanjutKeTahapPesan(pengirim, session, targetDate);
                    return;
                }

                // TAHAP 1b: User memilih salah satu tafsiran jam yang ambigu
                else if (session.step === 'WAITING_TIME_CLARIFY') {
                    const pilihan = parseInt(userText, 10);
                    const kandidat = session.pilihanWaktu || [];

                    if (isNaN(pilihan) || pilihan < 1 || pilihan > kandidat.length) {
                        const daftar = kandidat
                            .map((ts, i) => `*${i + 1}* = ${formatWaktuRingkas(new Date(ts))}`)
                            .join('\n');

                        await sock.sendMessage(pengirim, {
                            text: `❌ Balas dengan angka pilihannya saja.\n\n${daftar}\n\n_(Atau ketik *b* untuk batal)_`
                        });
                        return;
                    }

                    const terpilih = new Date(kandidat[pilihan - 1]);

                    if (terpilih.getTime() <= waktuSekarang) {
                        await sock.sendMessage(pengirim, { text: `❌ *Waktu sudah berlalu!* Masukkan waktu di masa depan.\n_(Atau ketik *b* untuk batal)_` });
                        return;
                    }

                    await lanjutKeTahapPesan(pengirim, session, terpilih);
                    return;
                }

                // TAHAP 3: Bot menunggu input Pengulangan (Recurrence)
                else if (session.step === 'WAITING_RECURRENCE') {
                    let tipePengulangan = 'sekali';
                    let labelPengulangan = 'Hanya sekali';

                    if (userText === '1') {
                        tipePengulangan = 'sekali';
                    } else if (userText === '2') {
                        tipePengulangan = 'harian';
                        labelPengulangan = '🔄 Setiap Hari';
                    } else if (userText === '3') {
                        tipePengulangan = 'mingguan';
                        labelPengulangan = '🔄 Setiap Minggu';
                    } else if (userText === '4') {
                        tipePengulangan = 'bulanan';
                        labelPengulangan = '🔄 Setiap Bulan';
                    } else if (userText === '5') {
                        tipePengulangan = 'tahunan';
                        labelPengulangan = '🔄 Setiap Tahun';
                    } else {
                        await sock.sendMessage(pengirim, { text: `❌ Pilihan tidak valid. Silakan balas dengan angka *1, 2, 3, 4, atau 5*.\n_(Atau ketik *b* untuk batal)_` });
                        return;
                    }

                    // Simpan ke SQLite
                    await db.run(
                        `INSERT INTO reminders (nomor_wa, pesan, waktu_eksekusi, status, created_at, tipe_pengulangan) VALUES (?, ?, ?, ?, ?, ?)`,
                        [pengirim, session.pesan, session.waktuEksekusi, 'pending', waktuSekarang, tipePengulangan]
                    );

                    await sock.sendMessage(pengirim, { 
                        text: `✅ *Jadwal tersimpan!*\n\nSaya akan mengingatkan:\n📝 "${session.pesan}"\n🗓️ Mulai: ${session.konfirmasiWaktu}\n🔁 Siklus: ${labelPengulangan}\n\n_Ketik *j* (atau *jadwal*) untuk melihat semua jadwal Anda._` 
                    });
                    
                    userSessions.delete(pengirim);
                    console.log(`📥 Jadwal ${tipePengulangan} tersimpan untuk ${namaPengirim}`);
                    return;
                }

                // TAHAP KONFIRMASI HAPUS SEMUA JADWAL
                else if (session.step === 'WAITING_DELETE_ALL') {
                    if (lowerText === 'ya' || lowerText === 'y' || lowerText === 's') {
                        await db.run(`DELETE FROM reminders WHERE nomor_wa = ? AND status = 'pending'`, [pengirim]);
                        await sock.sendMessage(pengirim, { text: `✅ Semua jadwal aktif Anda berhasil dihapus bersih!` });
                    } else {
                        await sock.sendMessage(pengirim, { text: `✅ Penghapusan massal dibatalkan.` });
                    }
                    
                    userSessions.delete(pengirim);
                    return;
                }

                // TAHAP KONFIRMASI HAPUS AKUN
                else if (session.step === 'WAITING_DELETE_ACCOUNT') {
                    if (lowerText === 'ya' || lowerText === 'y' || lowerText === 's') {
                        await db.run(`DELETE FROM reminders WHERE nomor_wa = ?`, [pengirim]);
                        await db.run(`DELETE FROM feedbacks WHERE nomor_wa = ?`, [pengirim]);
                        await db.run(`DELETE FROM users WHERE nomor_wa = ?`, [pengirim]);
                        
                        await sock.sendMessage(pengirim, { text: `✅ Akun dan seluruh data Anda (termasuk jadwal) telah berhasil dihapus dari sistem kami.\n\nKapan pun Anda butuh bot ini lagi, cukup balas pesan ini dengan sapaan.` });
                    } else {
                        await sock.sendMessage(pengirim, { text: `✅ Penghapusan akun dibatalkan.` });
                    }
                    
                    userSessions.delete(pengirim);
                    return;
                }

                // TAHAP MENUNGGU INPUT SARAN/LAPORAN
                else if (session.step === 'WAITING_FEEDBACK') {
                    if (userText.length > 500) {
                        await sock.sendMessage(pengirim, { text: `⚠️ *Masukan Terlalu Panjang!*\nMaksimal masukan adalah 500 karakter. Silakan ketik ulang masukan Anda dengan lebih ringkas. _(Ketik *b* untuk batal)_` });
                        return;
                    }

                    // Simpan ke SQLite tabel feedbacks
                    await db.run(
                        `INSERT INTO feedbacks (nomor_wa, nama, pesan, created_at) VALUES (?, ?, ?, ?)`,
                        [pengirim, namaPengirim, userText, waktuSekarang]
                    );

                    await sock.sendMessage(pengirim, { 
                        text: `✅ *Terima kasih atas masukannya!*\n\nSaran atau laporan Anda telah tersimpan dan sangat berharga untuk pengembangan bot ini ke depannya.` 
                    });
                    
                    userSessions.delete(pengirim);
                    console.log(`📥 [Feedback] Saran baru masuk dari ${namaPengirim}: "${userText}"`);
                    return;
                }
            }

            // 3. CEK FITUR AUTO-SNOOZE (MENGHENTIKAN SNOOZE)
            if (['ok', 'stop', 'selesai'].includes(lowerText)) {
                const updated = await db.run(
                    `UPDATE reminders SET status = 'sent' WHERE nomor_wa = ? AND status = 'pending' AND tipe_pengulangan = 'auto_snooze'`,
                    [pengirim]
                );
                
                if (updated.changes > 0) {
                    await sock.sendMessage(pengirim, {
                        text: `✅ *Pengingat dihentikan.* Terima kasih!`
                    });
                    return;
                }
                // Jika tidak ada snooze yang sedang berjalan, biarkan jatuh ke alur bawah (sapaan)
            }

            // 4. JIKA TIDAK ADA ALUR AKTIF (MULAI BARU)
            if (lowerText === 'ingatkan' || lowerText === 'i') {
                // Cek jumlah jadwal aktif (pending), batasi maksimal 50 agar tidak membebani sistem
                const checkCount = await db.get(`SELECT COUNT(id) as count FROM reminders WHERE nomor_wa = ? AND status = 'pending'`, [pengirim]);
                if (checkCount && checkCount.count >= MAX_REMINDER_PER_USER) {
                    await sock.sendMessage(pengirim, { text: `⚠️ *Batas Maksimal Pengingat Tercapai!*\nAnda sudah memiliki ${MAX_REMINDER_PER_USER} jadwal aktif. Silakan hapus beberapa jadwal yang sudah tidak relevan dengan mengetik *j* lalu *h [nomor]* sebelum membuat yang baru.` });
                    return;
                }

                userSessions.set(pengirim, { step: 'WAITING_TIME', terakhirAktif: waktuSekarang });
                await sock.sendMessage(pengirim, { 
                    text: `Halo Kak ${namaPengirim}, kapan Anda ingin diingatkan?\n\n_(Balas dengan waktu kasual seperti *10 menit*, *besok 8 malam*, atau *15:30*. Ketik *b* untuk batal)_` 
                });
            } 
            else if (lowerText === 'jadwal' || lowerText === 'list' || lowerText === 'j') {
                const daftarJadwal = await db.all(
                    `SELECT pesan, waktu_eksekusi, tipe_pengulangan FROM reminders WHERE nomor_wa = ? AND status = 'pending' ORDER BY waktu_eksekusi ASC`, 
                    [pengirim]
                );

                if (daftarJadwal.length === 0) {
                    await sock.sendMessage(pengirim, { 
                        text: `📝 *Tidak ada jadwal aktif.*\n\nSaat ini Anda tidak memiliki pengingat apa pun.` 
                    });
                } else {
                    let teksJadwal = `📋 *Daftar Pengingat Anda:*\n\n`;
                    
                    daftarJadwal.forEach((jadwal, index) => {
                        const waktu = new Date(jadwal.waktu_eksekusi).toLocaleString('id-ID', { 
                            weekday: 'short', year: 'numeric', month: 'short', 
                            day: 'numeric', hour: '2-digit', minute: '2-digit' 
                        });
                        
                        let labelUlang = '';
                        if (jadwal.tipe_pengulangan === 'harian') labelUlang = ' (🔄 Tiap Hari)';
                        if (jadwal.tipe_pengulangan === 'mingguan') labelUlang = ' (🔄 Tiap Minggu)';
                        if (jadwal.tipe_pengulangan === 'bulanan') labelUlang = ' (🔄 Tiap Bulan)';
                        if (jadwal.tipe_pengulangan === 'tahunan') labelUlang = ' (🔄 Tiap Tahun)';
                        
                        teksJadwal += `${index + 1}. *${jadwal.pesan}*${labelUlang}\n   🗓️ ${waktu}\n\n`;
                    });

                    teksJadwal += `_Ketik *h [nomor]* untuk membatalkan jadwal._`;
                    await sock.sendMessage(pengirim, { text: teksJadwal });
                }
            }
            else if (lowerText === 'hapus semua' || lowerText === 'hs') {
                const check = await db.get(`SELECT COUNT(id) as count FROM reminders WHERE nomor_wa = ? AND status = 'pending'`, [pengirim]);
                
                if (check.count === 0) {
                    await sock.sendMessage(pengirim, { text: `📝 Anda tidak memiliki jadwal aktif untuk dihapus.` });
                    return;
                }

                userSessions.set(pengirim, { step: 'WAITING_DELETE_ALL', terakhirAktif: waktuSekarang });
                await sock.sendMessage(pengirim, { 
                    text: `⚠️ Anda yakin ingin menghapus *${check.count} jadwal aktif*?\n\nBalas *y* untuk konfirmasi, atau ketik *b* untuk membatalkan.` 
                });
            }
            else if (lowerText === 'hapus akun' || lowerText === 'ha') {
                userSessions.set(pengirim, { step: 'WAITING_DELETE_ACCOUNT', terakhirAktif: waktuSekarang });
                await sock.sendMessage(pengirim, { 
                    text: `⚠️ *PERINGATAN!* ⚠️\n\nAnda yakin ingin menghapus akun Anda secara permanen?\n\nIni akan menghapus seluruh data jadwal Anda (aktif maupun yang sudah lewat) serta profil Anda dari sistem.\n\nBalas *y* untuk konfirmasi penghapusan akun, atau ketik *b* untuk membatalkan.` 
                });
            }
            else if (lowerText.startsWith('hapus ') || lowerText === 'hapus' || lowerText.startsWith('h ') || lowerText === 'h') {
                const arg = lowerText.startsWith('hapus') ? lowerText.slice(5).trim() : lowerText.slice(1).trim();
                
                const daftarJadwal = await db.all(
                    `SELECT id, pesan, waktu_eksekusi, tipe_pengulangan FROM reminders WHERE nomor_wa = ? AND status = 'pending' ORDER BY waktu_eksekusi ASC`, 
                    [pengirim]
                );

                if (daftarJadwal.length === 0) {
                    await sock.sendMessage(pengirim, { text: `📝 Anda tidak memiliki jadwal aktif untuk dihapus.` });
                    return;
                }

                if (!arg) {
                    let teksJadwal = `📋 *Daftar Pengingat Anda:*\n\n`;
                    
                    daftarJadwal.forEach((jadwal, index) => {
                        const waktu = new Date(jadwal.waktu_eksekusi).toLocaleString('id-ID', { 
                            weekday: 'short', year: 'numeric', month: 'short', 
                            day: 'numeric', hour: '2-digit', minute: '2-digit' 
                        });

                        let labelUlang = '';
                        if (jadwal.tipe_pengulangan === 'harian') labelUlang = ' (🔄 Tiap Hari)';
                        if (jadwal.tipe_pengulangan === 'mingguan') labelUlang = ' (🔄 Tiap Minggu)';
                        if (jadwal.tipe_pengulangan === 'bulanan') labelUlang = ' (🔄 Tiap Bulan)';
                        if (jadwal.tipe_pengulangan === 'tahunan') labelUlang = ' (🔄 Tiap Tahun)';

                        teksJadwal += `${index + 1}. *${jadwal.pesan}*${labelUlang}\n   🗓️ ${waktu}\n\n`;
                    });

                    teksJadwal += `💡 *Cara menghapus:*\nBalas pesan ini dengan mengetik *h [nomor]* (contoh: *h 1*)\nAtau ketik *hs* (atau *hapus semua*) untuk hapus semua.`;
                    await sock.sendMessage(pengirim, { text: teksJadwal });
                    return;
                }

                const nomorUrut = parseInt(arg);
                
                if (isNaN(nomorUrut)) {
                    await sock.sendMessage(pengirim, { text: `❌ Format salah. Nomor jadwal harus berupa angka.\nContoh: *h 2*` });
                    return;
                }

                if (nomorUrut < 1 || nomorUrut > daftarJadwal.length) {
                    await sock.sendMessage(pengirim, { 
                        text: `❌ Nomor jadwal tidak ditemukan. Anda hanya memiliki ${daftarJadwal.length} jadwal aktif.\n\nKetik *j* untuk melihat daftar nomornya.` 
                    });
                    return;
                }

                const targetJadwal = daftarJadwal[nomorUrut - 1]; 
                
                await db.run(`DELETE FROM reminders WHERE id = ?`, [targetJadwal.id]);
                await sock.sendMessage(pengirim, { text: `✅ Jadwal *"${targetJadwal.pesan}"* berhasil dihapus.` });
            }
            else if (lowerText === 'backup' && ADMIN_JID && pengirim === ADMIN_JID) {
                await sock.sendMessage(pengirim, { text: `⏳ Memulai backup manual ke Google Drive...` });
                const sukses = await jalankanBackupDatabase(db);
                if (sukses) {
                    await sock.sendMessage(pengirim, { text: `✅ Backup berhasil diunggah ke Google Drive.` });
                } else {
                    await sock.sendMessage(pengirim, { text: `❌ Gagal mengunggah backup. Cek log server untuk detailnya.` });
                }
            }
            // Perintah khusus admin: baca masukan yang selama ini masuk.
            // Tanpa ini tabel feedbacks hanya bisa dilihat lewat SQL manual di
            // server, sehingga saran user praktis tidak pernah terbaca.
            else if ((lowerText === 'lihat saran' || lowerText === 'ls') && ADMIN_JID && pengirim === ADMIN_JID) {
                const daftarSaran = await db.all(
                    `SELECT nama, pesan, created_at FROM feedbacks ORDER BY created_at DESC LIMIT 10`
                );

                if (daftarSaran.length === 0) {
                    await sock.sendMessage(pengirim, { text: `📭 Belum ada saran atau laporan yang masuk.` });
                } else {
                    const total = await db.get(`SELECT COUNT(id) as count FROM feedbacks`);
                    let teks = `📬 *${daftarSaran.length} Masukan Terbaru* (total ${total.count})\n\n`;

                    daftarSaran.forEach((s, i) => {
                        const waktu = new Date(s.created_at).toLocaleString('id-ID', {
                            day: 'numeric', month: 'short', year: 'numeric',
                            hour: '2-digit', minute: '2-digit'
                        });
                        teks += `${i + 1}. *${s.nama}* — ${waktu}\n${s.pesan}\n\n`;
                    });

                    await sock.sendMessage(pengirim, { text: teks.trim() });
                }
            }
            else if (lowerText === 'saran' || lowerText === 'lapor' || lowerText === 'feedback') {
                userSessions.set(pengirim, { step: 'WAITING_FEEDBACK', terakhirAktif: waktuSekarang });
                await sock.sendMessage(pengirim, { 
                    text: `Halo Kak ${namaPengirim}, silakan ketik saran, masukan, keluhan, atau laporan *bug* mengenai bot ini di bawah.\n\n_(Ketik *b* jika ingin membatalkan)_` 
                });
            }
            else if (lowerText === 'panduan' || lowerText === 'p' || lowerText === '!help' || lowerText === 'halo' || lowerText === 'ping' || lowerText === '?') {
                await sock.sendMessage(pengirim, { 
                    text: `💡 *Pusat Bantuan Bot Reminder*\n\nUntuk membuat jadwal, langsung saja ketik:\n_"Besok jam 7 pagi ingatkan saya bayar SPP"_\n\n*⌨️ Daftar Perintah Lainnya:*\n• *j* (atau *jadwal*) : Lihat daftar pengingat\n• *h 1* (atau *hapus 1*) : Hapus jadwal No. 1\n• *hs* (atau *hapus semua*) : Hapus semua\n• *ha* (atau *hapus akun*) : Hapus akun dan data Anda\n• *saran* (atau *lapor*) : Kirim masukan/bug\n• *b* (atau *batal*) : Membatalkan aksi\n• *p* (atau *panduan*) : Buka menu bantuan ini\n\n*⏱️ Cara Mengetik Waktu:*\n• Durasi: *5 menit* (atau 5 mnt), *2 jam*, *3 hari*\n• Hari ini: *14:30*, *jam 7 pagi*, *hari ini 07.00*, *nanti malam jam 8*\n• Besok/Lusa: *besok 08:00*, *besok pagi*, *lusa 3 sore*\n• Nama hari: *senin 3 sore*, *jumat jam 8 malam*\n• Spesifik (Tgl/Bln/Thn): *21/08/2026 15:00*` 
                });
            }
            else {
                // --- 🤖 AI NATURAL LANGUAGE INTERCEPTOR ---
                // Filter ringan: Hanya pesan dengan panjang >10 char yang mengandung kata kunci
                const kataKunci = ['ingat', 'jadwal', 'besok', 'lusa', 'nanti', 'jam', 'pagi', 'siang', 'sore', 'malam', 'hari', 'tiap', 'setiap'];
                const isBisaJadiJadwal = kataKunci.some(kata => lowerText.includes(kata));
                
                if (userText.length > 10 && userText.length <= 250 && isBisaJadiJadwal) {
                    // Beritahu pengguna kalau pesan sedang dianalisa AI
                    await sock.sendMessage(pengirim, { text: `🧠 _AI sedang mencerna jadwal Anda..._` });
                    
                    try {
                        const hasilAI = await parseJadwalWithAI(userText, new Date());
                        
                        if (hasilAI && hasilAI.is_jadwal) {
                            const targetWaktu = new Date(hasilAI.tanggal_waktu_iso).getTime();
                            
                            // Cek apakah waktu sudah lewat
                            if (targetWaktu <= waktuSekarang) {
                                await sock.sendMessage(pengirim, { text: `❌ AI mendeteksi waktu yang Anda sebutkan sudah berlalu. Silakan ketik jadwal di masa depan.` });
                                return;
                            }

                            // Simpan jadwal langsung ke Database
                            let dbSiklus = 'sekali';
                            let labelSiklus = 'Hanya sekali';
                            if (hasilAI.siklus === 'harian') { dbSiklus = 'harian'; labelSiklus = '🔄 Setiap Hari'; }
                            if (hasilAI.siklus === 'mingguan') { dbSiklus = 'mingguan'; labelSiklus = '🔄 Setiap Minggu'; }
                            if (hasilAI.siklus === 'bulanan') { dbSiklus = 'bulanan'; labelSiklus = '🔄 Setiap Bulan'; }
                            if (hasilAI.siklus === 'tahunan') { dbSiklus = 'tahunan'; labelSiklus = '🔄 Setiap Tahun'; }

                            await db.run(
                                `INSERT INTO reminders (nomor_wa, pesan, waktu_eksekusi, status, created_at, tipe_pengulangan) VALUES (?, ?, ?, ?, ?, ?)`,
                                [pengirim, hasilAI.pesan, targetWaktu, 'pending', waktuSekarang, dbSiklus]
                            );

                            const tglFormat = new Date(targetWaktu).toLocaleString('id-ID', {
                                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
                            });

                            await sock.sendMessage(pengirim, { 
                                text: `✨ *Jadwal Otomatis Tersimpan (AI)!*\n\n📝 "${hasilAI.pesan}"\n🗓️ Mulai: ${tglFormat}\n🔁 Siklus: ${labelSiklus}\n\n_Ketik *j* untuk melihat daftar jadwal Anda._` 
                            });
                            
                            console.log(`🧠 [AI] Jadwal berhasil diproses untuk ${namaPengirim}: ${hasilAI.pesan}`);
                        }
                    } catch (error) {
                        console.error('Error AI Interceptor:', error);
                        userSessions.set(pengirim, { step: 'WAITING_TIME', terakhirAktif: waktuSekarang });
                        await sock.sendMessage(pengirim, { 
                            text: `🧠 _Waduh, sistem cerdas saya sedang sibuk. Mari kita buat secara bertahap ya Kak._\n\nKapan Anda ingin diingatkan?\n_(Balas dengan waktu kasual seperti *10 menit*, *besok 8 malam*, atau *15:30*. Ketik *b* untuk batal)_` 
                        });
                    }
                }
            }
        } catch (error) {
            console.error('❌ Error saat query pengecekan SQLite:', error);
        }
    }
}

// Penjaga agar dua putaran cron tidak berjalan bersamaan. Karena sekarang ada
// jeda antar pengiriman, satu putaran bisa memakan waktu lebih dari satu menit.
let cronSedangBerjalan = false;

// Berjalan setiap 1 menit (* * * * *)
cron.schedule('* * * * *', async () => {
    if (!sock || !db) return; // Lewati jika WA/DB belum siap
    if (cronSedangBerjalan) return;

    cronSedangBerjalan = true;
    try {
        const waktuSekarang = new Date().getTime();

        // Ambil jadwal 'pending' sekaligus MENGGABUNGKANNYA (JOIN) dengan nama dari tabel users.
        // Dibatasi per putaran: kalau bot sempat mati beberapa jam, tunggakan
        // dicicil beberapa putaran alih-alih diledakkan sekaligus ke WhatsApp.
        const pendingReminders = await db.all(`
            SELECT r.id, r.nomor_wa, r.pesan, r.tipe_pengulangan, r.waktu_eksekusi, r.snooze_count, u.nama
            FROM reminders r
            LEFT JOIN users u ON r.nomor_wa = u.nomor_wa
            WHERE r.status = 'pending' AND r.waktu_eksekusi <= ?
            ORDER BY r.waktu_eksekusi ASC
            LIMIT ?
        `, [waktuSekarang, MAX_KIRIM_PER_PUTARAN]);

        if (pendingReminders.length === 0) return;

        console.log(`⏰ [Cron] Menemukan ${pendingReminders.length} reminder untuk dieksekusi...`);

        // Eksekusi pengiriman pesan satu per satu, dengan jeda di antaranya
        for (const [urutan, reminder] of pendingReminders.entries()) {
            try {
                if (urutan > 0) await tidur(JEDA_KIRIM_MS);

                // Gunakan nama dari database, jika kosong panggil Kak
                const namaUser = reminder.nama || 'Kak';

                const currentSnoozeCount = reminder.snooze_count || 0;
                const maxSnooze = 3;
                
                let footerText = '';
                if (currentSnoozeCount < maxSnooze) {
                    footerText = `\n_(Bot akan mengingatkan lagi dalam 10 menit. Balas *OK* untuk menghentikan)_`;
                }

                // PESAN UTAMA DITARUH DI PALING ATAS AGAR MUNCUL DI NOTIFIKASI
                await sock.sendMessage(reminder.nomor_wa, {
                    text: `*${reminder.pesan}*\n\n⏰ Halo ${namaUser}, waktunya pengingat Anda!${footerText}`
                });

                // Jadwal ulang ke kemunculan berikutnya yang masih di masa depan,
                // atau tandai selesai bila tipenya 'sekali' atau 'auto_snooze'.
                const berikutnya = hitungJadwalBerikutnya(
                    reminder.waktu_eksekusi,
                    reminder.tipe_pengulangan,
                    waktuSekarang
                );

                if (berikutnya) {
                    await db.run(`UPDATE reminders SET waktu_eksekusi = ? WHERE id = ?`, [berikutnya, reminder.id]);
                    console.log(`🔁 Pengingat ${reminder.tipe_pengulangan} dijadwalkan ulang ke ${new Date(berikutnya).toLocaleString('id-ID')}`);
                } else {
                    await db.run(`UPDATE reminders SET status = 'sent' WHERE id = ?`, [reminder.id]);
                }
                
                // BUAT JADWAL AUTO-SNOOZE JIKA BELUM MENCAPAI BATAS
                if (currentSnoozeCount < maxSnooze) {
                    const nextSnoozeTime = waktuSekarang + (10 * 60 * 1000);
                    await db.run(
                        `INSERT INTO reminders (nomor_wa, pesan, waktu_eksekusi, status, created_at, tipe_pengulangan, snooze_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [reminder.nomor_wa, reminder.pesan, nextSnoozeTime, 'pending', waktuSekarang, 'auto_snooze', currentSnoozeCount + 1]
                    );
                    console.log(`💤 Auto-snooze (ke-${currentSnoozeCount + 1}) dijadwalkan untuk ${reminder.nomor_wa.split('@')[0]}`);
                }

                console.log(`✅ Sukses mengirim reminder ke ${reminder.nomor_wa.split('@')[0]}`);
            } catch (sendError) {
                console.error(`❌ Gagal mengirim ke ${reminder.nomor_wa}:`, sendError);
            }
        }
    } catch (error) {
        console.error('❌ Error saat mengeksekusi cron SQLite:', error);
    } finally {
        cronSedangBerjalan = false;
    }
});

// ==========================================
// PEMBERSIHAN BERKALA (setiap hari pukul 03:00)
// ==========================================
// Tanpa ini tabel reminders menyimpan seluruh riwayat selamanya, dan kedua Map
// di memori terus bertambah seiring jumlah orang yang pernah menghubungi bot.
cron.schedule('0 3 * * *', async () => {
    try {
        if (db) {
            const batas = Date.now() - SIMPAN_RIWAYAT_HARI * 86400000;
            const hasil = await db.run(
                `DELETE FROM reminders WHERE status = 'sent' AND waktu_eksekusi < ?`,
                [batas]
            );
            if (hasil.changes > 0) {
                console.log(`🧹 ${hasil.changes} riwayat pengingat lama dibersihkan.`);
            }
        }

        const sekarang = Date.now();

        // Sesi yang ditinggalkan sudah kedaluwarsa secara logika saat user
        // mengirim pesan lagi, tapi milik user yang tidak pernah kembali tetap
        // menempati memori. Sapu di sini.
        let sesiDibuang = 0;
        for (const [jid, sesi] of userSessions) {
            if (sekarang - (sesi.terakhirAktif || 0) > SESI_KEDALUWARSA_MS) {
                userSessions.delete(jid);
                sesiDibuang += 1;
            }
        }

        // Entri anti-spam hanya berguna selama window-nya berjalan.
        let spamDibuang = 0;
        for (const [jid, data] of rateLimitMap) {
            if (sekarang - data.firstMessageTime > SPAM_WINDOW_MS) {
                rateLimitMap.delete(jid);
                spamDibuang += 1;
            }
        }

        if (sesiDibuang || spamDibuang) {
            console.log(`🧹 Memori dibersihkan: ${sesiDibuang} sesi, ${spamDibuang} entri anti-spam.`);
        }
    } catch (error) {
        console.error('❌ Error saat pembersihan berkala:', error);
    }
});

// ==========================================
// MENJALANKAN SISTEM
// ==========================================
async function startSystem() {
    console.log('🚀 Memulai sistem Bot Reminder...');
    console.log(`🕒 Zona waktu aktif: ${process.env.TZ} | Sekarang: ${new Date().toLocaleString('id-ID')}`);

    // 1. Inisialisasi Database Dulu
    await initDatabase();
    
    // 2. Baru connect WA
    connectToWhatsApp(); 
}

startSystem();