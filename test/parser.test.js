const test = require('node:test');
const assert = require('node:assert');
const { parseSmartTime } = require('../lib/parse-time');

// Waktu acuan tetap: Senin, 24 Agustus 2026 pukul 05:05 WIB.
// Sengaja meniru jam kejadian pada transkrip chat user asli.
const NOW = new Date(2026, 7, 24, 5, 5, 0, 0);

/** Format 'YYYY-MM-DD HH:mm' untuk perbandingan yang mudah dibaca saat gagal. */
function fmt(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Bantuan: pastikan input menghasilkan waktu pasti tertentu. */
function cekExact(input, harapan) {
    const hasil = parseSmartTime(input, NOW);
    assert.ok(hasil, `"${input}" seharusnya dikenali, tapi ditolak (null)`);
    assert.strictEqual(hasil.type, 'exact', `"${input}" seharusnya pasti, bukan ${hasil.type}`);
    assert.strictEqual(fmt(hasil.date), harapan, `"${input}"`);
}

/** Bantuan: pastikan input menghasilkan durasi (now + n menit). */
function cekDurasiMenit(input, menit) {
    const hasil = parseSmartTime(input, NOW);
    assert.ok(hasil, `"${input}" seharusnya dikenali, tapi ditolak (null)`);
    assert.strictEqual(hasil.type, 'exact');
    assert.strictEqual(hasil.date.getTime() - NOW.getTime(), menit * 60000, `"${input}"`);
}

// ========================================================
// 1. REGRESI DARI CHAT USER ASLI (24 Agustus 2026, 05:05)
//    Keempat input ini DITOLAK oleh parser lama.
// ========================================================
test('regresi: input yang gagal di chat user asli', () => {
    cekExact('nanti pagi jam 7 pagi', '2026-08-24 07:00');
    cekExact('buat nanti jam 7 pagi', '2026-08-24 07:00');
    cekExact('hari ini 07.00', '2026-08-24 07:00');
    cekExact('i hari ini jam 07.00', '2026-08-24 07:00');
});

test('regresi: variasi lain dari kalimat yang sama', () => {
    cekExact('jam 7 pagi', '2026-08-24 07:00');
    cekExact('tolong ingatkan saya jam 7 pagi', '2026-08-24 07:00');
    cekExact('hari ini jam 7 pagi ya', '2026-08-24 07:00');
    cekExact('besok pagi jam 7', '2026-08-25 07:00');
    cekExact('07.00', '2026-08-24 07:00');
    cekExact('07:00', '2026-08-24 07:00');
});

// ========================================================
// 2. SETIAP CONTOH YANG DIIKLANKAN PANDUAN HARUS JALAN
//    (dulu "nanti malam jam 8" tercantum tapi ditolak parser)
// ========================================================
test('panduan: semua contoh di teks bantuan benar-benar bisa diparse', () => {
    cekDurasiMenit('5 menit', 5);
    cekDurasiMenit('5 mnt', 5);
    cekDurasiMenit('2 jam', 120);
    cekDurasiMenit('3 hari', 3 * 24 * 60);
    cekExact('14:30', '2026-08-24 14:30');
    cekExact('2 siang', '2026-08-24 14:00');
    cekExact('nanti malam jam 8', '2026-08-24 20:00');
    cekExact('besok 08:00', '2026-08-25 08:00');
    cekExact('besok 3 sore', '2026-08-25 15:00');
    cekExact('lusa 3 sore', '2026-08-26 15:00');
    cekExact('25/08/2026 09:00', '2026-08-25 09:00');
    // Tahun disebut eksplisit -> dihormati apa adanya, walau sudah lewat.
    // Pemanggil yang menolaknya dengan pesan "waktu sudah berlalu".
    cekExact('21/08/2026 15:00', '2026-08-21 15:00');
});

// ========================================================
// 3. DURASI vs JAM DINDING (aturan: angka sebelum satuan = durasi)
// ========================================================
test('durasi dibedakan dari jam dinding lewat urutan kata', () => {
    cekDurasiMenit('2 jam', 120);
    cekDurasiMenit('2 jam lagi', 120);
    cekDurasiMenit('dalam 2 jam', 120);
    cekDurasiMenit('10 menit lagi', 10);
    cekDurasiMenit('30 detik', 0.5);
    cekDurasiMenit('2 minggu', 14 * 24 * 60);

    // "jam 2" adalah jam dinding, bukan durasi 2 jam
    const hasil = parseSmartTime('jam 2', NOW);
    assert.notStrictEqual(hasil.type, 'exact', '"jam 2" seharusnya ambigu, bukan durasi');
});

// ========================================================
// 4. BAGIAN HARI SEBAGAI PENGUBAH 12 -> 24 JAM
// ========================================================
test('bagian hari mengubah jam 12 menjadi 24 jam', () => {
    cekExact('7 malam', '2026-08-24 19:00');
    cekExact('8 malam', '2026-08-24 20:00');
    cekExact('3 sore', '2026-08-24 15:00');
    cekExact('1 siang', '2026-08-24 13:00');
    cekExact('11 siang', '2026-08-24 11:00');
    cekExact('12 siang', '2026-08-24 12:00');
    cekExact('9 pagi', '2026-08-24 09:00');
    cekExact('4 subuh', '2026-08-25 04:00'); // 04:00 hari ini sudah lewat
});

test('bug lama: "12 malam" dulu jadi siang, sekarang tengah malam', () => {
    cekExact('12 malam', '2026-08-25 00:00');
    cekExact('12 pagi', '2026-08-25 00:00');
    cekExact('tengah malam', '2026-08-25 00:00');
});

test('bagian hari berdiri sendiri memakai jam default', () => {
    cekExact('besok pagi', '2026-08-25 06:00');
    cekExact('besok siang', '2026-08-25 12:00');
    cekExact('besok sore', '2026-08-25 15:00');
    cekExact('besok malam', '2026-08-25 19:00');
    cekExact('nanti malam', '2026-08-24 19:00');
});

test('setengah jam ala Indonesia', () => {
    const hasil = parseSmartTime('setengah 8 pagi', NOW);
    assert.strictEqual(hasil.type, 'exact');
    assert.strictEqual(fmt(hasil.date), '2026-08-24 07:30');
});

// ========================================================
// 5. KETERANGAN HARI
// ========================================================
test('keterangan hari relatif', () => {
    cekExact('besok', '2026-08-25 08:00');       // tanpa jam -> default 08:00
    cekExact('lusa jam 9 pagi', '2026-08-26 09:00');
    cekExact('minggu depan', '2026-08-31 08:00');
    cekExact('hari ini jam 10 pagi', '2026-08-24 10:00');
});

test('nama hari menuju kemunculan berikutnya', () => {
    // NOW adalah hari Senin
    cekExact('kamis 9 pagi', '2026-08-27 09:00');
    cekExact('sabtu', '2026-08-29 08:00');
    cekExact('senin 3 sore', '2026-08-31 15:00'); // "senin" di hari Senin = Senin depan
    cekExact('jumat jam 8 malam', '2026-08-28 20:00');
    cekExact("jum'at jam 8 malam", '2026-08-28 20:00');
});

// ========================================================
// 6. TANGGAL EKSPLISIT (dulu wajib 2 digit + tahun 4 digit)
// ========================================================
test('tanggal eksplisit menerima 1 digit dan tahun opsional', () => {
    cekExact('25/08/2026 09:00', '2026-08-25 09:00');
    cekExact('5/9/2026 9:00', '2026-09-05 09:00');
    cekExact('5-9-26 09:00', '2026-09-05 09:00');
    cekExact('5/9', '2026-09-05 08:00');          // tanpa jam -> default 08:00
    cekExact('25 agustus jam 9 pagi', '2026-08-25 09:00');
    cekExact('1 september 2026 07:00', '2026-09-01 07:00');

    // Tanpa tahun & tanggalnya sudah lewat -> maksudnya tahun depan
    cekExact('21/08 15:00', '2027-08-21 15:00');
});

// ========================================================
// 7. JAM AMBIGU -> MINTA KLARIFIKASI, JANGAN MENEBAK DIAM-DIAM
// ========================================================
test('jam polos tanpa penanda pagi/malam menghasilkan dua pilihan', () => {
    const hasil = parseSmartTime('jam 7', NOW);
    assert.strictEqual(hasil.type, 'ambiguous');
    assert.deepStrictEqual(hasil.candidates.map(fmt), ['2026-08-24 07:00', '2026-08-24 19:00']);
});

test('kandidat yang sudah lewat digeser ke hari berikutnya', () => {
    // Pukul 13:00: 07:00 hari ini sudah lewat -> tawarkan 19:00 hari ini vs 07:00 besok
    const siang = new Date(2026, 7, 24, 13, 0, 0, 0);
    const hasil = parseSmartTime('jam 7', siang);
    assert.strictEqual(hasil.type, 'ambiguous');
    assert.deepStrictEqual(hasil.candidates.map(fmt), ['2026-08-24 19:00', '2026-08-25 07:00']);
});

test('tidak bertanya bila hanya satu tafsiran yang masuk akal', () => {
    // "hari ini jam 3": 03:00 sudah lewat, jadi pasti 15:00
    cekExact('hari ini jam 3', '2026-08-24 15:00');
    // Notasi 24 jam tidak pernah ambigu
    cekExact('jam 19', '2026-08-24 19:00');
    cekExact('19:00', '2026-08-24 19:00');
    // Penanda bagian hari menghilangkan ambiguitas
    cekExact('jam 7 malam', '2026-08-24 19:00');
});

test('balasan angka polos dianggap jam', () => {
    const hasil = parseSmartTime('7', NOW);
    assert.strictEqual(hasil.type, 'ambiguous');
    assert.deepStrictEqual(hasil.candidates.map(fmt), ['2026-08-24 07:00', '2026-08-24 19:00']);
});

// ========================================================
// 8. KATA SAMPAH TIDAK BOLEH MENGGAGALKAN PARSING
// ========================================================
test('kalimat penuh kata pengisi tetap terbaca', () => {
    cekExact('tolong ingatkan saya besok jam 9 pagi ya', '2026-08-25 09:00');
    cekExact('buat besok pagi aja', '2026-08-25 06:00');
    cekExact('mau di jam 8 malam dong', '2026-08-24 20:00');
    cekExact('bikin pengingat untuk lusa jam 10 pagi', '2026-08-26 10:00');
});

// ========================================================
// 9. INPUT YANG MEMANG HARUS DITOLAK
// ========================================================
test('input tanpa informasi waktu ditolak', () => {
    for (const input of ['', '   ', 'abcd', 'halo apa kabar', 'menit', 'jam', 'jam 25', 'jam 99']) {
        assert.strictEqual(parseSmartTime(input, NOW), null, `"${input}" seharusnya ditolak`);
    }
});

test('input tidak valid tidak melempar error', () => {
    assert.doesNotThrow(() => parseSmartTime(null, NOW));
    assert.doesNotThrow(() => parseSmartTime(undefined, NOW));
    assert.strictEqual(parseSmartTime(null, NOW), null);
});

// ========================================================
// 10. WAKTU YANG SUDAH LEWAT DIGESER KE BESOK (perilaku lama dipertahankan)
// ========================================================
test('jam yang sudah lewat hari ini otomatis jadi besok', () => {
    const sore = new Date(2026, 7, 24, 17, 0, 0, 0);
    const hasil = parseSmartTime('jam 9 pagi', sore);
    assert.strictEqual(hasil.type, 'exact');
    assert.strictEqual(fmt(hasil.date), '2026-08-25 09:00');
});
