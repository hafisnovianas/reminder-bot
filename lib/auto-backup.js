const cron = require('node-cron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');
const { GOOGLE_DRIVE_FOLDER_ID, GOOGLE_CREDENTIALS } = require('./config');

// Koneksi database, dipakai untuk membuat snapshot yang konsisten.
let dbAktif = null;

// Penanda bahwa cron sudah terdaftar. Tanpa ini, karena mulaiAutoBackup()
// dipanggil dari event 'connection open' yang terjadi setiap reconnect, satu
// jadwal cron baru menumpuk tiap kali — dan tengah malam backup terkirim
// sebanyak jumlah reconnect yang pernah terjadi.
let tugasBackup = null;

async function jalankanBackupDatabase(db) {
    let fileSementara = null;

    try {
        console.log('⏳ Memulai proses auto-backup database ke Google Drive...');

        if (!db) {
            console.log('⚠️  Auto-backup dilewati: koneksi database belum siap.');
            return false;
        }

        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `backup_reminder_db_${dateStr}.sqlite`;
        fileSementara = path.join(os.tmpdir(), `${Date.now()}_${fileName}`);

        // Menyalin file .sqlite yang sedang dipakai bisa menghasilkan
        // backup korup, karena mungkin ada transaksi yang belum selesai
        // ditulis. VACUUM INTO meminta SQLite sendiri menulis snapshot
        // yang utuh dan konsisten ke file baru.
        await db.exec(`VACUUM INTO '${fileSementara.replace(/'/g, "''")}'`);

        // Persiapan Autentikasi Google Drive OAuth2
        const { client_id, client_secret, refresh_token } = JSON.parse(GOOGLE_CREDENTIALS);
        const auth = new google.auth.OAuth2(client_id, client_secret);
        auth.setCredentials({ refresh_token });
        const drive = google.drive({ version: 'v3', auth });

        // Upload ke Google Drive
        const fileMetadata = {
            name: fileName,
            parents: [GOOGLE_DRIVE_FOLDER_ID]
        };
        const media = {
            mimeType: 'application/x-sqlite3',
            body: fs.createReadStream(fileSementara)
        };

        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id'
        });

        console.log(`✅ Backup database berhasil diunggah ke Google Drive (ID: ${response.data.id})`);
        return true;
    } catch (error) {
        console.error('❌ Gagal mengunggah backup database ke Google Drive:', error);
        return false;
    } finally {
        // Bersihkan snapshot agar tidak menumpuk di /tmp tiap hari.
        if (fileSementara) {
            try {
                await fs.promises.unlink(fileSementara);
            } catch (e) {
                // File memang belum sempat dibuat, tidak masalah.
            }
        }
    }
}

function mulaiAutoBackup(sock, db) {
    if (db) dbAktif = db;

    if (!GOOGLE_DRIVE_FOLDER_ID || !GOOGLE_CREDENTIALS) {
        console.log('ℹ️  Auto-backup dilewati: GOOGLE_DRIVE_FOLDER_ID atau GOOGLE_CREDENTIALS belum diisi.');
        return;
    }

    if (tugasBackup) return; // cukup didaftarkan sekali seumur proses

    // Berjalan setiap hari jam 00:00 (Tengah malam)
    tugasBackup = cron.schedule('0 0 * * *', async () => {
        await jalankanBackupDatabase(dbAktif);
    });

    console.log('✅ Fitur auto-backup Google Drive harian terjadwal aktif');
}

module.exports = { mulaiAutoBackup, jalankanBackupDatabase };
