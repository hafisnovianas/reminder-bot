// ========================================================
// KONFIGURASI TERPUSAT
// ========================================================
// Semua nilai yang dulu ditulis langsung di dalam kode dipindah ke sini dan
// bisa ditimpa lewat environment variable. Tujuannya dua: nomor pribadi tidak
// ikut tersimpan di git, dan mengubah batas/ambang tidak perlu deploy ulang.

const path = require('path');

/** Ambil integer dari env, pakai nilai bawaan bila kosong/tidak masuk akal. */
function angka(nilai, bawaan) {
    const n = parseInt(nilai, 10);
    return Number.isFinite(n) && n > 0 ? n : bawaan;
}

/**
 * Terima "6281234567890" maupun "6281234567890@s.whatsapp.net",
 * kembalikan JID yang siap dipakai sock.sendMessage. null bila tidak diisi.
 */
function keJid(nomor) {
    const bersih = String(nomor || '').replace(/[^0-9]/g, '');
    return bersih ? `${bersih}@s.whatsapp.net` : null;
}

module.exports = {
    // Lokasi database. Dulu ditulis './database.sqlite' yang artinya relatif ke
    // direktori tempat proses DIJALANKAN, bukan ke lokasi file kode. Kalau pm2
    // kebetulan start dari direktori lain, bot membuat database kosong baru dan
    // semua jadwal user seolah lenyap. Sekarang dipatok ke folder proyek.
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'database.sqlite'),

    // Simpan riwayat pengingat yang sudah terkirim selama sekian hari, lalu
    // dibersihkan otomatis agar tabel tidak tumbuh selamanya.
    SIMPAN_RIWAYAT_HARI: angka(process.env.SIMPAN_RIWAYAT_HARI, 30),

    // Tujuan auto-backup harian (dulu via WA, sekarang via Google Drive).
    // ADMIN_WA tetap dipakai untuk perintah khusus admin di index.js
    ADMIN_JID: keJid(process.env.ADMIN_WA),

    // Konfigurasi Google Drive untuk auto-backup
    GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    GOOGLE_CREDENTIALS: process.env.GOOGLE_CREDENTIALS || '',

    // Anti-spam: maksimal SPAM_THRESHOLD pesan dalam SPAM_WINDOW_MS.
    SPAM_THRESHOLD: angka(process.env.SPAM_THRESHOLD, 7),
    SPAM_WINDOW_MS: angka(process.env.SPAM_WINDOW_MS, 10000),

    // Batas jadwal aktif per user.
    MAX_REMINDER_PER_USER: angka(process.env.MAX_REMINDER_PER_USER, 50),

    // Berapa reminder yang dikirim per putaran cron, dan jeda antar pengiriman.
    // Mengirim puluhan pesan sekaligus (mis. setelah bot mati beberapa jam)
    // adalah pola yang membuat nomor WhatsApp kena blokir.
    MAX_KIRIM_PER_PUTARAN: angka(process.env.MAX_KIRIM_PER_PUTARAN, 30),
    JEDA_KIRIM_MS: angka(process.env.JEDA_KIRIM_MS, 1500),

    // Sesi tanya-jawab yang ditinggalkan user akan dilupakan setelah ini,
    // supaya pesan berikutnya tidak terlanjur dikira isi reminder.
    SESI_KEDALUWARSA_MS: angka(process.env.SESI_KEDALUWARSA_MS, 15 * 60 * 1000)
};
