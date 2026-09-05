# Bot Reminder WhatsApp

Bot pengingat pribadi lewat WhatsApp. User mengetik `i`, menuliskan pesannya,
lalu menyebutkan waktu dengan bahasa sehari-hari ("besok pagi jam 7", "2 jam
lagi", "senin 3 sore"). Bot menyimpan jadwalnya dan mengirim pengingat pada
waktunya, sekali atau berulang.

Dibangun dengan [Baileys](https://github.com/WhiskeySockets/Baileys) (client
WhatsApp tidak resmi) dan SQLite. Berjalan sebagai satu proses Node.js.

## Kebutuhan

- Node.js **>= 20.17.0** (dibatasi oleh `sqlite3`)
- Satu nomor WhatsApp khusus untuk bot
- Untuk produksi: server Linux + pm2

## Menjalankan pertama kali

```bash
npm install
npm start
```

Saat pertama dijalankan, QR Code muncul di terminal. Scan dari WhatsApp di
ponsel bot (Perangkat Tertaut → Tautkan Perangkat). Sesi tersimpan di folder
`auth_wa/` sehingga scan hanya perlu sekali.

> **Jangan menjalankan dua instance pada sesi yang sama.** Menjalankan
> `npm start` di laptop sementara bot produksi hidup akan membuat WhatsApp
> memutus salah satunya. Kalau perlu menguji lokal, hentikan dulu yang di
> server (`pm2 stop reminder-bot`).

## Konfigurasi

Semua lewat environment variable. Tidak ada yang wajib — bot tetap jalan
dengan nilai bawaan, kecuali auto-backup yang butuh `ADMIN_WA`.

| Variable | Bawaan | Keterangan |
|---|---|---|
| `TZ` | `Asia/Jakarta` | Zona waktu. **Penting**: server biasanya UTC, dan seluruh logika jadwal memakai jam lokal. Salah setel = semua pengingat meleset 7 jam. |
| `ADMIN_WA` | *(kosong)* | Nomor tujuan auto-backup harian, mis. `6281234567890`. Kalau kosong, fitur backup dilewati. |
| `DB_PATH` | `<folder proyek>/database.sqlite` | Lokasi file database. |
| `SPAM_THRESHOLD` | `7` | Maksimal pesan dalam satu window sebelum user diabaikan sementara. |
| `SPAM_WINDOW_MS` | `10000` | Panjang window anti-spam (ms). |
| `MAX_REMINDER_PER_USER` | `50` | Batas jadwal aktif per user. |
| `MAX_KIRIM_PER_PUTARAN` | `30` | Maksimal pengingat yang dikirim per putaran cron. |
| `JEDA_KIRIM_MS` | `1500` | Jeda antar pengiriman, untuk menghindari blokir WhatsApp. |
| `SESI_KEDALUWARSA_MS` | `900000` | Sesi tanya-jawab yang ditinggalkan dilupakan setelah ini (15 menit). |
| `SIMPAN_RIWAYAT_HARI` | `30` | Riwayat pengingat terkirim disimpan sekian hari, lalu dibersihkan otomatis. |

## Perintah bagi user

| Perintah | Fungsi |
|---|---|
| `i` / `ingatkan` | Buat pengingat baru |
| `j` / `jadwal` | Lihat daftar pengingat aktif |
| `h 1` / `hapus 1` | Hapus jadwal nomor 1 |
| `hs` / `hapus semua` | Hapus semua jadwal (dengan konfirmasi) |
| `saran` / `lapor` | Kirim masukan atau laporan bug |
| `b` / `batal` | Batalkan aksi yang sedang berjalan |
| `p` / `panduan` | Buka bantuan |

### Perintah admin

Hanya dikenali bila dikirim dari nomor `ADMIN_WA`:

| Perintah | Fungsi |
|---|---|
| `ls` / `lihat saran` | Tampilkan 10 masukan user terbaru |

## Struktur

```
index.js              alur utama: koneksi WA, penanganan pesan, cron
lib/config.js         semua konfigurasi, dibaca dari environment
lib/quiet-libsignal.js  cegah libsignal mencetak kunci sesi ke log
lib/parse-time.js     penerjemah waktu bahasa sehari-hari -> Date
lib/recurrence.js     perhitungan jadwal berikutnya untuk pengingat berulang
lib/auto-backup.js    backup database harian ke WhatsApp admin
test/                 test unit (node --test)
```

Tiga cron berjalan di dalam proses:

- **tiap menit** — cari pengingat jatuh tempo, kirim, jadwalkan ulang
- **00:00** — kirim backup database ke admin
- **03:00** — bersihkan riwayat lama dan memori sesi

## Test

```bash
npm test
```

Mencakup penerjemah waktu (termasuk kasus nyata dari chat user) dan
perhitungan pengulangan (termasuk bot mati berhari-hari dan luberan tanggal
seperti 31 Januari). Test dijalankan otomatis oleh CI sebelum deploy.

## Deploy

Push ke `main` memicu [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

1. Job `test` — `node --check` semua file JS, lalu `npm test`
2. Job `deploy` — hanya jalan bila job `test` lulus; salin kode via scp, `npm ci`, restart pm2

Secret yang dibutuhkan di GitHub: `REMOTE_HOST`, `REMOTE_USER`, `REMOTE_PORT`,
`SERVER_SSH_KEY`, `TARGET_DIR`, `ADMIN_WA`.

Yang **tidak** ikut tersalin dan aman di server: `auth_wa/` (sesi WhatsApp) dan
`database.sqlite`.

### Persiapan server sekali saja

```bash
pm2 startup          # jalankan baris sudo yang dicetaknya
pm2 save             # tanpa dua langkah ini, bot tidak hidup setelah reboot
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## Operasional

```bash
pm2 logs reminder-bot --lines 30 --nostream   # lihat log
pm2 flush reminder-bot                        # kosongkan log
pm2 restart reminder-bot --update-env         # restart, muat ulang env
pm2 env <id> | grep ADMIN_WA                  # cek env yang terbaca proses
```

Saat startup yang sehat, log berbunyi:

```
🚀 Memulai sistem Bot Reminder...
🕒 Zona waktu aktif: Asia/Jakarta | Sekarang: ...
🗄️  Database: /home/ubuntu/reminder-bot/database.sqlite
📦 Database SQLite siap dan tabel telah diperiksa.
✅ WhatsApp Berhasil Terhubung! Bot Reminder Siap!
✅ Fitur auto-backup harian terjadwal aktif
```

### Memulihkan dari backup

File backup adalah database SQLite utuh (dibuat dengan `VACUUM INTO`, jadi
konsisten). Untuk memulihkan: hentikan bot, timpa `database.sqlite` dengan
file backup, jalankan lagi.

### Kalau sesi WhatsApp logout

Log akan berbunyi `🛑 Sesi Logout`. Hapus folder `auth_wa/` di server,
restart, lalu scan QR baru lewat `pm2 logs`.

## Risiko yang diketahui

Hal-hal berikut belum tertangani dan disebutkan di sini supaya tidak terlupa:

- **Migrasi LID WhatsApp.** User diidentifikasi dengan JID (`msg.key.remoteJidAlt
  || msg.key.remoteJid`) sebagai primary key database. WhatsApp sedang
  memigrasi identitas ke format `@lid`. Bila bentuk JID seorang user berubah,
  bot akan menganggapnya user baru dan seluruh jadwalnya tidak terbaca lagi.
  Perlu strategi pemetaan identitas sebelum migrasi meluas.
- **Baileys masih release candidate** (`7.0.0-rc14`) dan tidak resmi. Perilaku
  bisa berubah mengikuti WhatsApp tanpa pemberitahuan.
- **Risiko blokir nomor.** Mengirim pesan otomatis lewat client tidak resmi
  selalu berisiko. Jeda pengiriman dan alur "simpan kontak dulu" mengurangi,
  bukan menghilangkan.
- **Penambalan `console` global.** `libsignal` mencetak seluruh objek
  `SessionEntry` — termasuk `privKey` dan `rootKey` — ke konsol pada empat
  tempat di `src/session_record.js`. Pemanggilannya memakai `console` global
  dan tidak bisa dimatikan lewat konfigurasi, sedangkan menyunting
  `node_modules` hilang setiap `npm ci`. Karena itu
  [`lib/quiet-libsignal.js`](lib/quiet-libsignal.js) menambal `console.info`
  dan `console.warn` saat startup untuk membuang lampiran objeknya. Kalau
  suatu saat `libsignal` mengubah teks pesannya, saringan ini berhenti bekerja
  tanpa pemberitahuan dan kunci akan tercetak lagi — daftar prefiksnya perlu
  diperiksa ulang setiap kali dependensi itu naik versi.
- **Satu proses, satu instance.** Tidak ada mekanisme kalau nanti perlu
  dijalankan ganda; SQLite dan sesi WA sama-sama mengasumsikan pemilik tunggal.
