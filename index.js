const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');

// Modul SQLite
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

let sock; // Variabel global untuk socket WA
let db;   // Variabel global untuk koneksi database SQLite

// Map memori sementara untuk melacak alur tanya-jawab user
const userSessions = new Map();

// Penerjemah waktu pintar (lihat lib/parse-time.js, diuji di test/parser.test.js)
const { parseSmartTime } = require('./lib/parse-time');

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
async function lanjutKeTahapPengulangan(pengirim, session, targetDate) {
    session.waktuEksekusi = targetDate.getTime();
    session.konfirmasiWaktu = formatWaktuLengkap(targetDate);
    session.step = 'WAITING_RECURRENCE';
    delete session.pilihanWaktu;

    await sock.sendMessage(pengirim, {
        text: `🗓️ Jadwal pertama diatur pada: *${session.konfirmasiWaktu}*\n\nApakah pengingat ini perlu diulang rutin?\nBalas dengan angka:\n*1* = Tidak (Hanya sekali)\n*2* = Ya, Setiap Hari\n*3* = Ya, Setiap Minggu (Di hari yang sama)\n\n_(Ketik *b* untuk membatalkan)_`
    });
}

// ========================================================
async function initDatabase() {
    // Membuka atau membuat file database.sqlite di folder yang sama
    db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

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
    } catch (e) {
        // Kolom sudah ada, aman dilanjutkan
    }
    
    console.log('📦 Database SQLite siap dan tabel telah diperiksa.');
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_wa');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

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
            
            if (shouldReconnect) {
                console.log('🔄 Menghubungkan ulang...');
                setTimeout(connectToWhatsApp, 2000); 
            } else {
                console.log('🛑 Sesi Logout. Folder auth_wa sudah tidak valid, silakan hapus folder tersebut dan restart server.');
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Berhasil Terhubung! Bot Reminder Siap!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        const pengirim = msg.key.remoteJidAlt || msg.key.remoteJid;
        
        // 🌟 MENGAMBIL NAMA PENGIRIM DARI PROFIL WA MEREKA
        const namaPengirim = msg.pushName || 'Kak'; 

        if (!text) return;

        const waktuSekarang = new Date().getTime();

        try {
            // 1. Cek apakah user sudah terdaftar di tabel users
            const user = await db.get(`SELECT * FROM users WHERE nomor_wa = ?`, [pengirim]);

            // 2. Jika user belum ada atau belum registrasi (is_registered = 0)
            if (!user || user.is_registered === 0) {
                if (['SUDAH', 'S', 'Y'].includes(text.toUpperCase().trim())) {
                    if (!user) {
                        await db.run(`INSERT INTO users (nomor_wa, nama, is_registered, created_at) VALUES (?, ?, 1, ?)`, [pengirim, namaPengirim, waktuSekarang]);
                    } else {
                        await db.run(`UPDATE users SET is_registered = 1, nama = ? WHERE nomor_wa = ?`, [namaPengirim, pengirim]);
                    }
                    
                    await sock.sendMessage(pengirim, { 
                        text: `✅ *Terima kasih ${namaPengirim}! Nomor Anda telah diverifikasi.*\n\nSekarang Anda bisa membuat pengingat baru cukup dengan mengetik:\n*i* (atau *ingatkan*)\n\n_💡 Ketik *p* (atau *panduan*) kapan saja untuk melihat buku panduan bot._` 
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
            const session = userSessions.get(pengirim);

            if (session) {
                // TAHAP 1: Bot sedang menunggu input Pesan
                if (session.step === 'WAITING_MESSAGE') {
                    session.pesan = userText;          
                    session.step = 'WAITING_TIME';     
                    
                    await sock.sendMessage(pengirim, { 
                        text: `Siap! Kapan saya harus mengingatkan:\n*"${userText}"*?\n\n(Balas dengan waktu kasual seperti *10 menit*, *besok 8 malam*, atau *15:30*)\n\n_💡 Bingung formatnya? Ketik *p* (panduan).\n❌ Ketik *b* (batal) jika tidak jadi._` 
                    });
                    return;
                }
                
                // TAHAP 2: Bot sedang menunggu input Waktu
                else if (session.step === 'WAITING_TIME') {
                    if (lowerText === 'panduan' || lowerText === 'p') {
                        await sock.sendMessage(pengirim, { 
                            text: `💡 *Panduan Bot Reminder*\n\n*⌨️ Daftar Perintah Cepat:*\n• *i* (atau *ingatkan*) : Buat jadwal baru\n• *j* (atau *jadwal*) : Lihat daftar jadwal\n• *h 1* (atau *hapus 1*) : Hapus jadwal No. 1\n• *hs* (atau *hapus semua*) : Hapus semua\n• *saran* (atau *lapor*) : Kirim masukan/bug\n• *b* (atau *batal*) : Batal membuat jadwal\n• *p* (atau *panduan*) : Buka menu bantuan\n\n*⏱️ Cara Mengetik Waktu:*\n• Durasi: *5 menit* (atau 5 mnt), *2 jam*, *3 hari*\n• Hari ini: *14:30*, *jam 7 pagi*, *hari ini 07.00*, *nanti malam jam 8*\n• Besok/Lusa: *besok 08:00*, *besok pagi*, *lusa 3 sore*\n• Nama hari: *senin 3 sore*, *jumat jam 8 malam*\n• Spesifik (Tgl/Bln/Thn Jam:Menit): *25/08/2026 09:00*\n\n_Santai saja, kalimat biasa juga dimengerti — contoh: "buat besok pagi jam 7"._\n\nSilakan balas waktu untuk *" ${session.pesan} "* sekarang.\n_(Atau ketik *b* untuk batal)_` 
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

                    // Pindah ke tahap 3: Pengulangan
                    await lanjutKeTahapPengulangan(pengirim, session, targetDate);
                    return;
                }

                // TAHAP 2b: User memilih salah satu tafsiran jam yang ambigu
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

                    await lanjutKeTahapPengulangan(pengirim, session, terpilih);
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
                    } else {
                        await sock.sendMessage(pengirim, { text: `❌ Pilihan tidak valid. Silakan balas dengan angka *1, 2, atau 3*.\n_(Atau ketik *b* untuk batal)_` });
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

                // TAHAP MENUNGGU INPUT SARAN/LAPORAN
                else if (session.step === 'WAITING_FEEDBACK') {
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

            // 3. JIKA TIDAK ADA ALUR AKTIF (MULAI BARU)
            if (lowerText === 'ingatkan' || lowerText === 'i') {
                userSessions.set(pengirim, { step: 'WAITING_MESSAGE' });
                await sock.sendMessage(pengirim, { 
                    text: `Halo Kak ${namaPengirim}, apa pesan pengingatnya?\n\n_(Balas dengan inti pesannya saja, contoh: "Bayar tagihan listrik". Ketik *b* untuk batal)_` 
                });
            } 
            else if (lowerText === 'jadwal' || lowerText === 'list' || lowerText === 'j') {
                const daftarJadwal = await db.all(
                    `SELECT pesan, waktu_eksekusi, tipe_pengulangan FROM reminders WHERE nomor_wa = ? AND status = 'pending' ORDER BY waktu_eksekusi ASC`, 
                    [pengirim]
                );

                if (daftarJadwal.length === 0) {
                    await sock.sendMessage(pengirim, { 
                        text: `📝 *Tidak ada jadwal aktif.*\n\nSaat ini Anda tidak memiliki pengingat apa pun. Ketik *i* (atau *ingatkan*) untuk membuat jadwal baru.` 
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
                        
                        teksJadwal += `${index + 1}. *${jadwal.pesan}*${labelUlang}\n   🗓️ ${waktu}\n\n`;
                    });

                    teksJadwal += `_Ketik *i* (atau *ingatkan*) untuk menambah jadwal._\n_Ketik *h [nomor]* (atau *hapus [nomor]*) untuk membatalkan jadwal._`;
                    await sock.sendMessage(pengirim, { text: teksJadwal });
                }
            }
            else if (lowerText === 'hapus semua' || lowerText === 'hs') {
                const check = await db.get(`SELECT COUNT(id) as count FROM reminders WHERE nomor_wa = ? AND status = 'pending'`, [pengirim]);
                
                if (check.count === 0) {
                    await sock.sendMessage(pengirim, { text: `📝 Anda tidak memiliki jadwal aktif untuk dihapus.` });
                    return;
                }

                userSessions.set(pengirim, { step: 'WAITING_DELETE_ALL' });
                await sock.sendMessage(pengirim, { 
                    text: `⚠️ Anda yakin ingin menghapus *${check.count} jadwal aktif*?\n\nBalas *y* untuk konfirmasi, atau ketik *b* untuk membatalkan.` 
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
            else if (lowerText === 'saran' || lowerText === 'lapor' || lowerText === 'feedback') {
                userSessions.set(pengirim, { step: 'WAITING_FEEDBACK' });
                await sock.sendMessage(pengirim, { 
                    text: `Halo Kak ${namaPengirim}, silakan ketik saran, masukan, keluhan, atau laporan *bug* mengenai bot ini di bawah.\n\n_(Ketik *b* jika ingin membatalkan)_` 
                });
            }
            else if (lowerText === 'panduan' || lowerText === 'p' || lowerText === '!help' || lowerText === 'halo' || lowerText === 'ping' || lowerText === '?') {
                await sock.sendMessage(pengirim, { 
                    text: `💡 *Pusat Bantuan Bot Reminder*\n\n*⌨️ Daftar Perintah Cepat:*\n• *i* (atau *ingatkan*) : Buat pengingat baru\n• *j* (atau *jadwal*) : Lihat daftar pengingat\n• *h 1* (atau *hapus 1*) : Hapus jadwal No. 1\n• *hs* (atau *hapus semua*) : Hapus semua\n• *saran* (atau *lapor*) : Kirim masukan/bug\n• *b* (atau *batal*) : Membatalkan aksi\n• *p* (atau *panduan*) : Buka menu bantuan ini\n\n*⏱️ Cara Mengetik Waktu:*\n• Durasi: *5 menit* (atau 5 mnt), *2 jam*, *3 hari*\n• Hari ini: *14:30*, *jam 7 pagi*, *hari ini 07.00*, *nanti malam jam 8*\n• Besok/Lusa: *besok 08:00*, *besok pagi*, *lusa 3 sore*\n• Nama hari: *senin 3 sore*, *jumat jam 8 malam*\n• Spesifik (Tgl/Bln/Thn): *21/08/2026 15:00*\n\n_Santai saja, kalimat biasa juga dimengerti — contoh: "buat besok pagi jam 7"._\n\n_Ketik *i* (atau *ingatkan*) untuk mulai membuat jadwal._` 
                });
            }
        } catch (error) {
            console.error('❌ Error saat query pengecekan SQLite:', error);
        }
    });
}

// Berjalan setiap 1 menit (* * * * *)
cron.schedule('* * * * *', async () => {
    if (!sock || !db) return; // Lewati jika WA/DB belum siap

    const waktuSekarang = new Date().getTime();

    try {
        // Ambil semua jadwal 'pending' sekaligus MENGGABUNGKANNYA (JOIN) dengan nama dari tabel users
        const pendingReminders = await db.all(`
            SELECT r.id, r.nomor_wa, r.pesan, r.tipe_pengulangan, r.waktu_eksekusi, u.nama 
            FROM reminders r
            LEFT JOIN users u ON r.nomor_wa = u.nomor_wa
            WHERE r.status = 'pending' AND r.waktu_eksekusi <= ?
        `, [waktuSekarang]);

        if (pendingReminders.length === 0) return;

        console.log(`⏰ [Cron] Menemukan ${pendingReminders.length} reminder untuk dieksekusi...`);

        // Eksekusi pengiriman pesan satu per satu
        for (const reminder of pendingReminders) {
            try {
                // Gunakan nama dari database, jika kosong panggil Kak
                const namaUser = reminder.nama || 'Kak';

                // PESAN UTAMA DITARUH DI PALING ATAS AGAR MUNCUL DI NOTIFIKASI
                await sock.sendMessage(reminder.nomor_wa, { 
                    text: `*${reminder.pesan}*\n\n⏰ Halo ${namaUser}, waktunya pengingat Anda!` 
                });

                // Update status atau jadwal ulang berdasarkan tipe pengulangan
                if (reminder.tipe_pengulangan === 'harian') {
                    // Tambah 24 jam (86400000 ms) ke waktu eksekusi saat ini
                    const nextTime = reminder.waktu_eksekusi + 86400000;
                    await db.run(`UPDATE reminders SET waktu_eksekusi = ? WHERE id = ?`, [nextTime, reminder.id]);
                    console.log(`🔁 Pengingat harian dijadwalkan ulang untuk besok.`);
                } else if (reminder.tipe_pengulangan === 'mingguan') {
                    // Tambah 7 hari (604800000 ms) ke waktu eksekusi
                    const nextTime = reminder.waktu_eksekusi + 604800000;
                    await db.run(`UPDATE reminders SET waktu_eksekusi = ? WHERE id = ?`, [nextTime, reminder.id]);
                    console.log(`🔁 Pengingat mingguan dijadwalkan ulang untuk minggu depan.`);
                } else {
                    // Jika 'sekali', tandai sent agar tidak terkirim lagi
                    await db.run(`UPDATE reminders SET status = 'sent' WHERE id = ?`, [reminder.id]);
                }
                
                console.log(`✅ Sukses mengirim reminder ke ${reminder.nomor_wa.split('@')[0]}`);
            } catch (sendError) {
                console.error(`❌ Gagal mengirim ke ${reminder.nomor_wa}:`, sendError);
            }
        }
    } catch (error) {
        console.error('❌ Error saat mengeksekusi cron SQLite:', error);
    }
});

// ==========================================
// MENJALANKAN SISTEM
// ==========================================
async function startSystem() {
    console.log('🚀 Memulai sistem Bot Reminder...');
    
    // 1. Inisialisasi Database Dulu
    await initDatabase();
    
    // 2. Baru connect WA
    connectToWhatsApp(); 
}

startSystem();