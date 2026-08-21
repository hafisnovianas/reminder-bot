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

// ========================================================
// FUNGSI PENERJEMAH WAKTU FORMAT KAKU
// ========================================================
function parseExactFormat(text) {
    const now = new Date();
    text = text.trim();

    // 1. Pola: HH:mm (contoh: 17:30) untuk hari ini
    const timeMatch = text.match(/^(\d{2}):(\d{2})$/);
    if (timeMatch) {
        const d = new Date(now);
        d.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
        return d;
    }

    // 2. Pola: DD/MM/YYYY HH:mm (contoh: 21/08/2026 15:00)
    const dateMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (dateMatch) {
        const day = parseInt(dateMatch[1]);
        const month = parseInt(dateMatch[2]) - 1; // Di JS, indeks bulan dimulai dari 0
        const year = parseInt(dateMatch[3]);
        const hours = parseInt(dateMatch[4]);
        const minutes = parseInt(dateMatch[5]);
        return new Date(year, month, day, hours, minutes, 0, 0);
    }

    return null; // Gagal mengenali format
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
        // Jika nama tidak disetel, gunakan sapaan default "Kak"
        const namaPengirim = msg.pushName || 'Kak'; 

        if (!text) return;

        const waktuSekarang = new Date().getTime();

        try {
            // 1. Cek apakah user sudah terdaftar di tabel users
            const user = await db.get(`SELECT * FROM users WHERE nomor_wa = ?`, [pengirim]);

            // 2. Jika user belum ada atau belum registrasi (is_registered = 0)
            if (!user || user.is_registered === 0) {
                // Jika mereka mengetik SUDAH untuk konfirmasi
                if (text.toUpperCase().trim() === 'SUDAH') {
                    if (!user) {
                        await db.run(`INSERT INTO users (nomor_wa, nama, is_registered, created_at) VALUES (?, ?, 1, ?)`, [pengirim, namaPengirim, waktuSekarang]);
                    } else {
                        await db.run(`UPDATE users SET is_registered = 1, nama = ? WHERE nomor_wa = ?`, [namaPengirim, pengirim]);
                    }
                    
                    await sock.sendMessage(pengirim, { 
                        text: `✅ *Terima kasih ${namaPengirim}! Nomor Anda telah diverifikasi.*\n\nSekarang Anda bisa membuat pengingat baru cukup dengan mengetik:\n*ingatkan*` 
                    });
                    console.log(`👤 User baru terverifikasi: ${namaPengirim} (${pengirim})`);
                    return; // Hentikan proses, tunggu chat berikutnya
                } 
                // Jika mereka mengetik hal lain (belum konfirmasi)
                else {
                    // Ambil nomor bot secara dinamis untuk VCard
                    const botNumber = sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : '';
                    
                    const vcard = 'BEGIN:VCARD\n'
                                + 'VERSION:3.0\n'
                                + 'FN:Bot Reminder\n' 
                                + 'ORG:Layanan Asisten Pribadi;\n' 
                                + `TEL;type=CELL;type=VOICE;waid=${botNumber}:+${botNumber}\n` 
                                + 'END:VCARD';

                    await sock.sendMessage(pengirim, {
                        text: `👋 *Halo ${namaPengirim}! Saya adalah Bot Pengingat (Reminder).*\n\nAgar pesan pengingat nantinya tidak telat atau masuk ke folder SPAM oleh sistem WhatsApp, silakan *Simpan Kartu Kontak* di bawah ini terlebih dahulu.\n\nJika sudah disimpan, balas pesan ini dengan mengetik: *SUDAH*`
                    });

                    // Kirim kartu kontak
                    await sock.sendMessage(pengirim, {
                        contacts: {
                            displayName: 'Bot Reminder',
                            contacts: [{ vcard }]
                        }
                    });

                    // Catat ke database dengan status belum teregistrasi (0) jika baru pertama kali chat
                    if (!user) {
                        await db.run(`INSERT INTO users (nomor_wa, nama, is_registered, created_at) VALUES (?, ?, 0, ?)`, [pengirim, namaPengirim, waktuSekarang]);
                    }
                    return; // Hentikan eksekusi, abaikan perintah !ingatkan sampai mereka balas SUDAH
                }
            }

            // ========================================================
            // AREA DI BAWAH INI HANYA BISA DIAKSES OLEH USER TERDAFTAR
            // ========================================================

            const userText = text.trim();
            const lowerText = userText.toLowerCase();

            // 1. CEK FITUR PEMBATALAN
            if (lowerText === 'batal') {
                if (userSessions.has(pengirim)) {
                    userSessions.delete(pengirim);
                    await sock.sendMessage(pengirim, { text: `✅ Aksi telah dibatalkan.` });
                }
                return; // Hentikan proses
            }

            // 2. CEK STATUS ALUR PERCAKAPAN SAAT INI
            const session = userSessions.get(pengirim);

            if (session) {
                // TAHAP 1: Bot sedang menunggu input Pesan
                if (session.step === 'WAITING_MESSAGE') {
                    session.pesan = userText;          // Simpan pesannya
                    session.step = 'WAITING_TIME';     // Pindah ke tahap waktu
                    
                    await sock.sendMessage(pengirim, { 
                        text: `Siap, kapan saya harus mengingatkan "${userText}"?\n\n(Balas dengan format:\n*HH:mm* = untuk hari ini jam segitu\n*DD/MM/YYYY HH:mm* = untuk spesifik tanggal\n\nKetik BATAL jika tidak jadi)` 
                    });
                    return;
                }
                
                // TAHAP 2: Bot sedang menunggu input Waktu
                else if (session.step === 'WAITING_TIME') {
                    const targetDate = parseExactFormat(userText);

                    if (!targetDate) {
                        await sock.sendMessage(pengirim, { 
                            text: `❌ *Format waktu tidak dikenali!*\n\nSilakan balas dengan format yang tepat:\n*HH:mm* (contoh: 17:30)\natau\n*DD/MM/YYYY HH:mm* (contoh: 21/08/2026 08:00)` 
                        });
                        return; // Biarkan status tetap WAITING_TIME agar user bisa mencoba lagi
                    }

                    const waktuEksekusi = targetDate.getTime();

                    if (waktuEksekusi <= waktuSekarang) {
                        await sock.sendMessage(pengirim, { text: `❌ *Waktu sudah berlalu!* Masukkan waktu di masa depan.` });
                        return;
                    }

                    const konfirmasiWaktu = targetDate.toLocaleString('id-ID', { 
                        weekday: 'long', year: 'numeric', month: 'long', 
                        day: 'numeric', hour: '2-digit', minute: '2-digit' 
                    });

                    // Simpan ke SQLite
                    await db.run(
                        `INSERT INTO reminders (nomor_wa, pesan, waktu_eksekusi, status, created_at) VALUES (?, ?, ?, ?, ?)`,
                        [pengirim, session.pesan, waktuEksekusi, 'pending', waktuSekarang]
                    );

                    await sock.sendMessage(pengirim, { 
                        text: `✅ *Jadwal tersimpan!*\n\nSaya akan mengingatkan:\n📝 "${session.pesan}"\n🗓️ Pada: ${konfirmasiWaktu}` 
                    });
                    
                    // Hapus ingatan percakapan karena tugas sudah selesai
                    userSessions.delete(pengirim);
                    console.log(`📥 Jadwal tersimpan untuk ${namaPengirim} pada ${konfirmasiWaktu}`);
                    return;
                }
                
                // TAHAP KONFIRMASI HAPUS SEMUA JADWAL
                else if (session.step === 'WAITING_DELETE_ALL') {
                    if (lowerText === 'ya') {
                        // Hapus secara permanen dari database
                        await db.run(`DELETE FROM reminders WHERE nomor_wa = ? AND status = 'pending'`, [pengirim]);
                        await sock.sendMessage(pengirim, { text: `✅ Semua jadwal aktif Anda berhasil dihapus bersig!` });
                    } else {
                        await sock.sendMessage(pengirim, { text: `✅ Penghapusan massal dibatalkan.` });
                    }
                    
                    userSessions.delete(pengirim);
                    return;
                }
            }

            // 3. JIKA TIDAK ADA ALUR AKTIF (MULAI BARU)
            if (lowerText === 'ingatkan') {
                userSessions.set(pengirim, { step: 'WAITING_MESSAGE' });
                await sock.sendMessage(pengirim, { 
                    text: `Halo kak ${namaPengirim}, apa pesan yang ingin saya ingatkan?\n\n(Ketik intinya saja, contoh: Kuliah. Atau ketik BATAL jika tidak jadi)` 
                });
            } 
            else if (lowerText === 'jadwal' || lowerText === 'list') {
                // Ambil data jadwal yang masih pending khusus untuk nomor ini
                const daftarJadwal = await db.all(
                    `SELECT pesan, waktu_eksekusi FROM reminders WHERE nomor_wa = ? AND status = 'pending' ORDER BY waktu_eksekusi ASC`, 
                    [pengirim]
                );

                if (daftarJadwal.length === 0) {
                    await sock.sendMessage(pengirim, { 
                        text: `📝 *Tidak ada jadwal aktif.*\n\nSaat ini Anda tidak memiliki pengingat apa pun. Ketik *ingatkan* untuk membuat jadwal baru.` 
                    });
                } else {
                    let teksJadwal = `📋 *Daftar Pengingat Anda:*\n\n`;
                    
                    daftarJadwal.forEach((jadwal, index) => {
                        // Ubah angka timestamp kembali menjadi teks tanggal yang mudah dibaca
                        const waktu = new Date(jadwal.waktu_eksekusi).toLocaleString('id-ID', { 
                            weekday: 'short', year: 'numeric', month: 'short', 
                            day: 'numeric', hour: '2-digit', minute: '2-digit' 
                        });
                        
                        teksJadwal += `${index + 1}. *${jadwal.pesan}*\n   🗓️ ${waktu}\n\n`;
                    });

                    teksJadwal += `_Ketik *ingatkan* untuk menambah jadwal._\n_Ketik *hapus [nomor]* untuk membatalkan jadwal._`;

                    await sock.sendMessage(pengirim, { text: teksJadwal });
                }
            }
            // ==========================================
            // FITUR BARU: MENGHAPUS JADWAL (IDE 1 & 3)
            // ==========================================
            else if (lowerText === 'hapus semua') {
                // Cek dulu apakah dia punya jadwal pending
                const check = await db.get(`SELECT COUNT(id) as count FROM reminders WHERE nomor_wa = ? AND status = 'pending'`, [pengirim]);
                
                if (check.count === 0) {
                    await sock.sendMessage(pengirim, { text: `📝 Anda tidak memiliki jadwal aktif untuk dihapus.` });
                    return;
                }

                // Masukkan ke State Machine untuk minta konfirmasi
                userSessions.set(pengirim, { step: 'WAITING_DELETE_ALL' });
                await sock.sendMessage(pengirim, { 
                    text: `⚠️ Anda yakin ingin menghapus *${check.count} jadwal aktif*?\n\nBalas *YA* untuk konfirmasi, atau ketik *BATAL* untuk membatalkan.` 
                });
            }
            else if (lowerText.startsWith('hapus')) {
                const arg = lowerText.replace('hapus', '').trim();
                
                // Ambil daftar jadwal di awal karena akan dipakai untuk ditampilkan (jika arg kosong) dan untuk dihapus
                const daftarJadwal = await db.all(
                    `SELECT id, pesan, waktu_eksekusi FROM reminders WHERE nomor_wa = ? AND status = 'pending' ORDER BY waktu_eksekusi ASC`, 
                    [pengirim]
                );

                // Jika ternyata tidak punya jadwal sama sekali
                if (daftarJadwal.length === 0) {
                    await sock.sendMessage(pengirim, { text: `📝 Anda tidak memiliki jadwal aktif untuk dihapus.` });
                    return;
                }

                // Skenario: Jika argumen kosong (hanya mengetik "hapus")
                if (!arg) {
                    let teksJadwal = `📋 *Daftar Pengingat Anda:*\n\n`;
                    
                    daftarJadwal.forEach((jadwal, index) => {
                        const waktu = new Date(jadwal.waktu_eksekusi).toLocaleString('id-ID', { 
                            weekday: 'short', year: 'numeric', month: 'short', 
                            day: 'numeric', hour: '2-digit', minute: '2-digit' 
                        });
                        teksJadwal += `${index + 1}. *${jadwal.pesan}*\n   🗓️ ${waktu}\n\n`;
                    });

                    // Berikan edukasi cara pakainya
                    teksJadwal += `💡 *Cara menghapus:*\nBalas pesan ini dengan mengetik *hapus [nomor]* (contoh: *hapus 1*)\nAtau ketik *hapus semua*.`;
                    
                    await sock.sendMessage(pengirim, { text: teksJadwal });
                    return;
                }

                const nomorUrut = parseInt(arg);
                
                // Error Handling 2: Jika yang diketik bukan angka
                if (isNaN(nomorUrut)) {
                    await sock.sendMessage(pengirim, { text: `❌ Format salah. Nomor jadwal harus berupa angka.\nContoh: *hapus 2*` });
                    return;
                }

                // Error Handling 3: Jika nomor urut di luar batas (kebesaran/kekecilan)
                if (nomorUrut < 1 || nomorUrut > daftarJadwal.length) {
                    await sock.sendMessage(pengirim, { 
                        text: `❌ Nomor jadwal tidak ditemukan. Anda hanya memiliki ${daftarJadwal.length} jadwal aktif.\n\nKetik *jadwal* untuk melihat daftar nomornya.` 
                    });
                    return;
                }

                const targetJadwal = daftarJadwal[nomorUrut - 1]; // Array index mulai dari 0
                
                // Eksekusi penghapusan jadwal spesifik tersebut
                await db.run(`DELETE FROM reminders WHERE id = ?`, [targetJadwal.id]);
                await sock.sendMessage(pengirim, { text: `✅ Jadwal *"${targetJadwal.pesan}"* berhasil dihapus.` });
            }
            // ==========================================
            else if (lowerText === '!help' || lowerText === 'halo' || lowerText === 'ping') {
                await sock.sendMessage(pengirim, {
                    text: `🤖 *Halo kak ${namaPengirim}! Saya Bot Reminder.*\n\nUntuk membuat pengingat baru, ketik: *ingatkan*\nUntuk melihat daftar pengingat aktif, ketik: *jadwal*`
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
            SELECT r.id, r.nomor_wa, r.pesan, u.nama 
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

                // Update status di SQLite agar tidak dikirim ulang
                await db.run(`UPDATE reminders SET status = 'sent' WHERE id = ?`, [reminder.id]);
                
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