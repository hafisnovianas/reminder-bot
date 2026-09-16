const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const url = require('url');

const CREDENTIALS_PATH = 'oauth_credentials.json';
const PORT = 3000;

if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`❌ File ${CREDENTIALS_PATH} tidak ditemukan!`);
    console.error('Silakan unduh file Client ID dari Google Cloud dan ganti namanya menjadi oauth_credentials.json');
    process.exit(1);
}

const rawKeys = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
const keys = rawKeys.installed || rawKeys.web;

if (!keys || !keys.client_id) {
    console.error(`❌ Format file ${CREDENTIALS_PATH} salah atau bukan OAuth Client ID.`);
    process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(
    keys.client_id,
    keys.client_secret,
    `http://localhost:${PORT}/oauth2callback`
);

const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // Meminta Refresh Token
    prompt: 'consent',      // Memaksa agar selalu diberi Refresh Token baru
    scope: ['https://www.googleapis.com/auth/drive.file'],
});

const server = http.createServer(async (req, res) => {
    try {
        const q = url.parse(req.url, true).query;
        if (req.url.startsWith('/oauth2callback')) {
            if (q.error) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<h1>Error</h1><p>' + q.error + '</p>');
                return;
            }
            
            // Dapatkan token dari code
            const { tokens } = await oAuth2Client.getToken(q.code);
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>✅ Autentikasi Berhasil!</h1><p>Silakan tutup tab browser ini dan kembali ke terminal Anda.</p>');
            
            console.log('\n✅ AUTENTIKASI BERHASIL!');
            console.log('\nIni adalah REFRESH TOKEN Anda:');
            console.log('\n=============================================');
            console.log(tokens.refresh_token || "Token tidak ditemukan, pastikan Anda menekan 'Allow/Izinkan'.");
            console.log('=============================================\n');
            console.log('⚠️ Simpan teks di atas. Kita akan membutuhkannya untuk disetel di rahasia server (GitHub Secret).');
            
            // Matikan server setelah berhasil
            server.close();
            process.exit(0);
        }
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error: ' + e.message);
        console.error(e);
        server.close();
        process.exit(1);
    }
});

server.listen(PORT, () => {
    console.log('\n🌐 [SERVER LOKAL BERJALAN]\n');
    console.log('Silakan buka URL berikut di browser Anda untuk memberikan izin (klik Ctrl + Click):');
    console.log('\n' + authUrl + '\n');
    console.log('Menunggu Anda login di browser...');
});
