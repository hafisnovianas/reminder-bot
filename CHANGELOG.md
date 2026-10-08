# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Dukungan WhatsApp Group**: Membuka akses bot untuk grup. Bot kini akan merespons apabila di-tag/mention (`@BotReminder`). Pembuatan jadwal di grup langsung diarahkan secara *one-shot* ke AI (tanpa State Machine) untuk mencegah *spamming*.
- **Sistem Keamanan Grup**: Memperbarui deteksi *Anti-Spam* berbasis ID peserta (bukan ID grup). Mengimplementasikan sistem otorisasi di mana hanya pembuat jadwal yang bisa menghapus jadwalnya sendiri di dalam grup.
- **Fitur Hapus Akun**: Menambahkan perintah `ha` atau `hapus akun` yang memungkinkan pengguna untuk menghapus profil dan seluruh data jadwal mereka secara permanen dari database.
- **AI Parser Integration**: Menambahkan dukungan `groq-sdk` dan model `openai/gpt-oss-20b` untuk memungkinkan pengguna membuat jadwal menggunakan bahasa natural (contoh: "besok jam 3 sore ingatkan minum obat").
- **Auto-Fallback System**: Sistem *hybrid* cerdas yang akan secara otomatis mengalihkan pengguna ke metode pembuatan jadwal manual (tanya-jawab) apabila API Groq sedang *down* atau *rate limit*.

### Changed
- **Auto-Snooze di Grup**: Menonaktifkan fitur *auto-snooze* (pengulangan pengingat 3x setiap 10 menit) dan pesan *footer* ("Balas OK untuk menghentikan") khusus untuk pengingat yang dikirim ke grup, agar tidak menyebabkan *spamming* obrolan di grup.
- **Urutan Alur Manual (Fallback)**: Mengubah urutan pertanyaan (*State Machine*) saat membuat jadwal secara manual atau saat AI gagal. Bot kini akan menanyakan target waktu terlebih dahulu ("Kapan Anda ingin diingatkan?"), baru kemudian menanyakan isi pesan pengingatnya. Hal ini membuat percakapan terasa lebih natural dan tegas.

### Fixed
- **Penanganan Status Koneksi & Error 428 (Connection Closed)**: Menambahkan state `isWaReady` agar cron pengingat tidak mencoba mengirim pesan saat socket WhatsApp sedang offline/reconnecting. Menambahkan pemutusan loop batch jika terjadi putus koneksi di tengah pengiriman.
- **Pencegahan Zombie Process (Anti-Zombie)**: Menangani `DisconnectReason.loggedOut` (401) dengan keluar secara bersih (`process.exit(1)`) agar proses tidak menggantung tanpa koneksi, serta mempercepat reconnect instan pada `DisconnectReason.restartRequired` (515).
- **Deteksi Mention Grup (LID)**: Memperbaiki *bug* di mana bot mengabaikan tag di grup jika nomor pengirim disembunyikan oleh WhatsApp. Kode kini mengecek `sock.user.lid` (Local ID) selain JID biasa.
- **Bug Pendaftaran**: Memperbaiki masalah di mana balasan huruf tunggal `s` (sebagai konfirmasi) tidak dikenali oleh sistem yang berakibat pengguna terjebak pada pesan sapaan bot.
- **Fleksibilitas Perintah Hapus**: Memperbaiki pembacaan perintah hapus agar juga mendukung format tanpa spasi seperti `h1` atau `hapus1` (sebelumnya hanya membaca `h 1` atau `hapus 1`).
- **UX Penyambutan & Panduan**: Menghapus instruksi pembuatan jadwal manual (`ketik i`) dari teks sambutan pendaftaran dan menu panduan (`p`). Menggantinya dengan panduan berfokus pada natural language/AI agar terlihat lebih modern.
- **GitHub Actions (`deploy.yml`)**: Menghapus langkah `npm test` untuk menghemat kuota *rate limit* API Groq, dan menyuntikkan variabel `GROQ_API_KEY` pada tahap *deploy* PM2.
- **AI Parser Prompt (Format 24 Jam)**: Menambahkan penegasan aturan format 24 jam pada *system prompt* AI agar waktu sore/malam tidak lagi keliru ditulis sebagai format 12 jam (pagi hari) yang memicu deteksi waktu lampau.
- **Alur Jadwal Manual (State Machine)**: Memperbaiki *ReferenceError* di mana fungsi `lanjutKeTahapPesan` tidak dapat mengakses fungsi `kirimBalasan` yang menyebabkan bot hening dan membaca input chat berikutnya sebagai isi pesan.
