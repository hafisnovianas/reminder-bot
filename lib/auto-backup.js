const cron = require('node-cron');
const fs = require('fs');

function mulaiAutoBackup(sock) {
    const adminNumber = '6281534856394@s.whatsapp.net';

    // Berjalan setiap hari jam 00:00 (Tengah malam)
    cron.schedule('0 0 * * *', async () => {
        try {
            console.log('⏳ Memulai proses auto-backup database...');
            if (fs.existsSync('./database.sqlite')) {
                const dateStr = new Date().toISOString().split('T')[0];
                const fileName = "backup_reminder_db_" + dateStr + ".sqlite";

                await sock.sendMessage(adminNumber, {
                    document: { url: './database.sqlite' },
                    mimetype: 'application/x-sqlite3',
                    fileName: fileName,
                    caption: 📦 *Auto Backup Database*\nTanggal:  + dateStr + \n\nSimpan file ini dengan baik.
                });
                console.log('✅ Backup database berhasil dikirim ke Admin WhatsApp');
            }
        } catch (error) {
            console.error('❌ Gagal mengirim backup database:', error);
        }
    });
    console.log('✅ Fitur auto-backup harian terjadwal aktif');
}

module.exports = { mulaiAutoBackup };
