const cron = require('node-cron');
const fs = require('fs');
const { ADMIN_JID } = require('./config');

// Socket terbaru. Saat WA reconnect, index.js membuat socket BARU dan socket
// lama mati. Cron di bawah harus selalu memakai yang terbaru, bukan yang
// kebetulan aktif saat cron pertama kali didaftarkan.
let socketAktif = null;

// Penanda bahwa cron sudah terdaftar. Tanpa ini, karena mulaiAutoBackup()
// dipanggil dari event 'connection open' yang terjadi setiap reconnect, satu
// jadwal cron baru menumpuk tiap kali — dan tengah malam backup terkirim
// sebanyak jumlah reconnect yang pernah terjadi.
let tugasBackup = null;

function mulaiAutoBackup(sock) {
    socketAktif = sock;

    if (!ADMIN_JID) {
        console.log('ℹ️  Auto-backup dilewati: environment variable ADMIN_WA belum diisi.');
        return;
    }

    if (tugasBackup) return; // cukup didaftarkan sekali seumur proses

    // Berjalan setiap hari jam 00:00 (Tengah malam)
    tugasBackup = cron.schedule('0 0 * * *', async () => {
        try {
            console.log('⏳ Memulai proses auto-backup database...');

            if (!socketAktif) {
                console.log('⚠️  Auto-backup ditunda: WhatsApp sedang tidak terhubung.');
                return;
            }

            if (!fs.existsSync('./database.sqlite')) {
                console.log('⚠️  Auto-backup dilewati: file database.sqlite tidak ditemukan.');
                return;
            }

            const dateStr = new Date().toISOString().split('T')[0];
            const fileName = `backup_reminder_db_${dateStr}.sqlite`;

            await socketAktif.sendMessage(ADMIN_JID, {
                document: { url: './database.sqlite' },
                mimetype: 'application/x-sqlite3',
                fileName: fileName,
                caption: `📦 *Auto Backup Database*\nTanggal: ${dateStr}\n\nSimpan file ini dengan baik.`
            });

            console.log('✅ Backup database berhasil dikirim ke Admin WhatsApp');
        } catch (error) {
            console.error('❌ Gagal mengirim backup database:', error);
        }
    });

    console.log('✅ Fitur auto-backup harian terjadwal aktif');
}

module.exports = { mulaiAutoBackup };
