const test = require('node:test');
const assert = require('node:assert');
const { hitungJadwalBerikutnya } = require('../lib/recurrence');

/** Format 'YYYY-MM-DD HH:mm' agar mudah dibaca saat test gagal. */
function fmt(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const pada = (...args) => new Date(...args).getTime();

// ========================================================
// 1. KASUS NORMAL: BOT SEHAT, LEWAT SATU SIKLUS SAJA
// ========================================================
test('siklus normal maju satu langkah', () => {
    const jadwal = pada(2026, 8, 5, 7, 0);       // Sabtu, 5 Sep 2026 07:00
    const sekarang = pada(2026, 8, 5, 7, 0, 30); // baru saja dikirim

    assert.strictEqual(fmt(hitungJadwalBerikutnya(jadwal, 'harian', sekarang)), '2026-09-06 07:00');
    assert.strictEqual(fmt(hitungJadwalBerikutnya(jadwal, 'mingguan', sekarang)), '2026-09-12 07:00');
    assert.strictEqual(fmt(hitungJadwalBerikutnya(jadwal, 'bulanan', sekarang)), '2026-10-05 07:00');
    assert.strictEqual(fmt(hitungJadwalBerikutnya(jadwal, 'tahunan', sekarang)), '2027-09-05 07:00');
});

test('jam dan menit tidak pernah bergeser', () => {
    const jadwal = pada(2026, 8, 5, 21, 45);
    const sekarang = pada(2026, 8, 5, 21, 45, 10);
    assert.strictEqual(fmt(hitungJadwalBerikutnya(jadwal, 'harian', sekarang)), '2026-09-06 21:45');
});

// ========================================================
// 2. BUG UTAMA: BOT MATI BEBERAPA HARI
//    Versi lama hanya +1 siklus, jadwal barunya masih di masa lalu, dan
//    cron mengirim ulang tiap menit untuk hari-hari yang sudah lewat.
// ========================================================
test('bot mati 3 hari: langsung lompat ke masa depan, bukan ke kemarin', () => {
    const jadwal = pada(2026, 8, 5, 7, 0);
    const sekarang = pada(2026, 8, 8, 9, 0); // bot baru hidup 3 hari kemudian

    const hasil = hitungJadwalBerikutnya(jadwal, 'harian', sekarang);
    assert.ok(hasil > sekarang, 'jadwal berikutnya wajib di masa depan');
    assert.strictEqual(fmt(hasil), '2026-09-09 07:00');
});

test('bot mati sebulan: mingguan tetap jatuh di hari yang sama', () => {
    const jadwal = pada(2026, 8, 5, 7, 0); // Sabtu
    const sekarang = pada(2026, 9, 3, 12, 0);

    const hasil = hitungJadwalBerikutnya(jadwal, 'mingguan', sekarang);
    assert.ok(hasil > sekarang);
    assert.strictEqual(new Date(hasil).getDay(), 6, 'harus tetap hari Sabtu');
    assert.strictEqual(fmt(hasil), '2026-10-10 07:00');
});

test('apa pun lamanya bot mati, hasilnya selalu di masa depan', () => {
    const jadwal = pada(2026, 0, 1, 8, 0);
    for (const tipe of ['harian', 'mingguan', 'bulanan', 'tahunan']) {
        for (const tahun of [2026, 2027, 2030]) {
            const sekarang = pada(tahun, 5, 15, 10, 0);
            const hasil = hitungJadwalBerikutnya(jadwal, tipe, sekarang);
            assert.ok(hasil > sekarang, `${tipe} pada ${tahun} menghasilkan waktu lampau`);
        }
    }
});

// ========================================================
// 3. BUG LUBERAN TANGGAL: 31 Jan + 1 bulan dulu jadi 3 Maret
// ========================================================
test('bulanan dari tanggal 31 dijepit ke akhir bulan, bukan meluber', () => {
    const jadwal = pada(2026, 0, 31, 9, 0); // 31 Januari 2026
    const sekarang = pada(2026, 0, 31, 9, 1);

    // 2026 bukan kabisat -> Februari berakhir di tanggal 28
    assert.strictEqual(fmt(hitungJadwalBerikutnya(jadwal, 'bulanan', sekarang)), '2026-02-28 09:00');
});

test('tanggal 31 kembali utuh di bulan yang punya 31 hari', () => {
    // Dari 28 Februari hasil jepitan, acuan tetap tanggal 31 yang asli.
    const asli = pada(2026, 0, 31, 9, 0);
    const sekarang = pada(2026, 2, 1, 0, 0); // 1 Maret, Februari sudah lewat

    // Melompati Februari, mendarat di 31 Maret — bukan 28 Maret.
    assert.strictEqual(fmt(hitungJadwalBerikutnya(asli, 'bulanan', sekarang)), '2026-03-31 09:00');
});

test('31 Desember menyeberang tahun dengan benar', () => {
    const jadwal = pada(2026, 11, 31, 23, 30);
    const sekarang = pada(2026, 11, 31, 23, 31);
    assert.strictEqual(fmt(hitungJadwalBerikutnya(jadwal, 'bulanan', sekarang)), '2027-01-31 23:30');
});

test('29 Februari tahun kabisat jatuh ke 28 di tahun biasa', () => {
    const jadwal = pada(2028, 1, 29, 10, 0); // 2028 kabisat
    const sekarang = pada(2028, 1, 29, 10, 1);
    assert.strictEqual(fmt(hitungJadwalBerikutnya(jadwal, 'tahunan', sekarang)), '2029-02-28 10:00');
});

// ========================================================
// 4. TIPE YANG TIDAK BERULANG
// ========================================================
test('tipe sekali dan nilai tak dikenal mengembalikan null', () => {
    const jadwal = pada(2026, 8, 5, 7, 0);
    const sekarang = pada(2026, 8, 5, 7, 1);

    assert.strictEqual(hitungJadwalBerikutnya(jadwal, 'sekali', sekarang), null);
    assert.strictEqual(hitungJadwalBerikutnya(jadwal, undefined, sekarang), null);
    assert.strictEqual(hitungJadwalBerikutnya(jadwal, null, sekarang), null);
    assert.strictEqual(hitungJadwalBerikutnya(jadwal, 'mingguanan', sekarang), null);
});

test('waktu tidak valid tidak melempar error', () => {
    assert.doesNotThrow(() => hitungJadwalBerikutnya(NaN, 'harian', Date.now()));
    assert.strictEqual(hitungJadwalBerikutnya(NaN, 'harian', Date.now()), null);
});
