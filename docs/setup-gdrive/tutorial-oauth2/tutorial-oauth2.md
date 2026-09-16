# 📦 Tutorial: Mendapatkan OAuth2 Refresh Token (Google Drive)

Karena Service Account tidak memiliki kuota penyimpanan (0 bytes) untuk pengguna gratis, kita harus menggunakan metode **OAuth2**. Dengan metode ini, bot akan meminjam identitas Gmail Anda (yang memiliki kuota 15GB atau lebih) untuk melakukan *upload* file ke Google Drive.

## Langkah 1: Aktifkan Google Drive API
Sebelum mengatur OAuth, pastikan API Google Drive sudah aktif di *project* Anda:
1. Buka tautan ini: **[Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)**.
2. Pastikan Anda berada di *project* yang benar (cek *dropdown* di bagian atas).
3. Klik tombol biru **Enable** (Aktifkan). Jika tombolnya tertulis "Manage", berarti API sudah aktif dan Anda bisa lanjut ke Langkah 2.

## Langkah 2: Konfigurasi Google Auth Platform (Branding)
*(Catatan: Tampilan Google Cloud telah diperbarui menjadi "Google Auth Platform").*

1. Buka [Google Cloud Console](https://console.cloud.google.com/).
2. Pastikan Anda berada di *project* Anda melalui menu *dropdown* di bagian atas.
3. Klik tautan jalan pintas ini untuk langsung menuju halaman konfigurasi: **[Buka Halaman Google Auth Platform](https://console.cloud.google.com/auth/overview)**. (Atau secara manual cari di menu navigasi utama: **Google Auth Platform** > **Overview**).
4. Di halaman *OAuth Overview* tersebut, klik tombol biru **Get Started** di bagian tengah bawah layar untuk mulai membuat *Branding*.
5. **Tahap 1: App Information**
   Isi `App name` (misal: `Reminder Bot Backup`) dan pilih email Anda di kolom `User support email`. Lalu klik **Next**.
   <br>![App Information](img/01-app-info.png)
6. **Tahap 2: Audience**
   Pilih tipe user **External**. 
   **PENTING:** Di bagian bawah halaman ini, cari bagian **Test users**. Klik tombol **+ Add Users** lalu ketikkan alamat Gmail Anda (email langganan 5TB yang akan dipakai untuk *login*). Jika tidak ditambahkan, Anda akan terkena *Error 403: access_denied* saat *login*. Setelah ditambah, klik **Next**.
   <br>![Audience External](img/02-audience.png)
7. **Tahap 3: Contact Information**
   Isi email Anda di kolom `Developer contact information`. Centang persetujuan jika ada, lalu klik **Create**.
   <br>![Contact Information](img/03-contact-info.png)

## Langkah 3: Buat OAuth Client ID
1. Setelah *Branding* selesai, klik menu **Clients** di *sidebar* sebelah kiri (masih di dalam bagian *Google Auth Platform*).
2. Klik tombol **+ Create client** di bagian atas (di sebelah tulisan *Clients*).
   <br>![Menu Create OAuth Client ID](img/04-create-client.png)
3. Pada halaman pembuatan *Client*, pilih **Web application** di menu *dropdown* Application type.
   <br>![Pilih Web Application](img/05-web-client-form.png)
4. Beri nama (bebas), misal: `Web Client 1`.
5. Scroll ke bawah ke bagian **Authorized redirect URIs**.
6. Klik **+ ADD URI** lalu ketik persis seperti ini: `http://localhost:3000/oauth2callback`
7. Klik tombol **CREATE**.

## Langkah 4: Unduh File JSON Kunci
1. Setelah berhasil dibuat, akan muncul jendela *popup* berisi Client ID dan Client Secret Anda.
   <br>![Popup Client ID & Secret](img/06-client-secret.png)
2. Di jendela *popup* tersebut, **tidak ada tombol *download***. Silakan klik saja tombol **OK** di pojok kanan bawah *popup* untuk menutupnya.
3. Anda akan dikembalikan ke daftar *Clients*. Di baris nama *Client* yang baru Anda buat, lihat ke sisi paling kanan dan klik **ikon Download** (berbentuk panah ke bawah) untuk mengunduh file JSON-nya.
4. Ubah nama file yang baru didownload tersebut menjadi **`oauth_credentials.json`**.
4. Pindahkan file `oauth_credentials.json` ini ke dalam **folder proyek bot Anda** (bersamaan dengan letak `index.js`).

## Langkah 5: Jalankan Script Pembangkit Token
Sekarang buka terminal/CMD Anda, pastikan Anda berada di folder proyek bot, lalu ketik:
```bash
node get-token.js
```
1. Script akan memberikan sebuah **URL panjang**. Klik URL tersebut (atau *copy-paste* ke browser).
2. Login menggunakan akun Gmail Anda (yang berlangganan 5TB).
3. Jika muncul layar peringatan *"Google hasn't verified this app"*, klik **Advanced (Lanjutan)** > **Go to Reminder Bot Backup (unsafe)**.
4. Klik **Allow/Izinkan** untuk memberikan akses Google Drive.
5. Anda akan dialihkan ke layar putih bertuliskan "✅ Autentikasi Berhasil!".
6. Buka kembali terminal/CMD Anda. Script tadi sudah mencetak sebuah kode panjang yang disebut **Refresh Token**.

## Langkah 6: Simpan ke GitHub Secrets
Agar bot bisa menggunakan kredensial ini di server (*production*), Anda harus menggabungkan 3 informasi penting ke dalam GitHub Secrets dengan nama **`GOOGLE_CREDENTIALS`**.

1. Buka *repository* GitHub Anda > **Settings** > **Secrets and variables** > **Actions**.
2. Edit atau buat *secret* bernama `GOOGLE_CREDENTIALS`.
3. Masukkan teks dengan format JSON persis seperti di bawah ini (gabungkan data dari file `oauth_credentials.json` dan *Refresh Token* yang baru Anda dapatkan dari terminal):

```json
{
  "client_id": "ISI_DENGAN_CLIENT_ID_ANDA",
  "client_secret": "ISI_DENGAN_CLIENT_SECRET_ANDA",
  "refresh_token": "ISI_DENGAN_REFRESH_TOKEN_ANDA"
}
```

4. Simpan, dan selesai! Bot Reminder Anda kini siap melakukan *backup* otomatis ke Google Drive setiap hari.
