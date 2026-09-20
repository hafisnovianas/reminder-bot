# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Fitur Hapus Akun**: Menambahkan perintah `ha` atau `hapus akun` yang memungkinkan pengguna untuk menghapus profil dan seluruh data jadwal mereka secara permanen dari database.
- **AI Parser Integration**: Menambahkan dukungan `groq-sdk` dan model `openai/gpt-oss-20b` untuk memungkinkan pengguna membuat jadwal menggunakan bahasa natural (contoh: "besok jam 3 sore ingatkan minum obat").
- **Auto-Fallback System**: Sistem *hybrid* cerdas yang akan secara otomatis mengalihkan pengguna ke metode pembuatan jadwal manual (tanya-jawab) apabila API Groq sedang *down* atau *rate limit*.
### Changed
- **Urutan Alur Manual (Fallback)**: Mengubah urutan pertanyaan (*State Machine*) saat membuat jadwal secara manual atau saat AI gagal. Bot kini akan menanyakan target waktu terlebih dahulu ("Kapan Anda ingin diingatkan?"), baru kemudian menanyakan isi pesan pengingatnya. Hal ini membuat percakapan terasa lebih natural dan tegas.

### Fixed
- **Bug Pendaftaran**: Memperbaiki masalah di mana balasan huruf tunggal `s` (sebagai konfirmasi) tidak dikenali oleh sistem yang berakibat pengguna terjebak pada pesan sapaan bot.
- **Fleksibilitas Perintah Hapus**: Memperbaiki pembacaan perintah hapus agar juga mendukung format tanpa spasi seperti `h1` atau `hapus1` (sebelumnya hanya membaca `h 1` atau `hapus 1`).
- **UX Penyambutan & Panduan**: Menghapus instruksi pembuatan jadwal manual (`ketik i`) dari teks sambutan pendaftaran dan menu panduan (`p`). Menggantinya dengan panduan berfokus pada natural language/AI agar terlihat lebih modern.
- **GitHub Actions (`deploy.yml`)**: Menghapus langkah `npm test` untuk menghemat kuota *rate limit* API Groq, dan menyuntikkan variabel `GROQ_API_KEY` pada tahap *deploy* PM2.
