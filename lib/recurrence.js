// ========================================================
// PENJADWALAN ULANG PENGINGAT BERULANG
// ========================================================
// Dua masalah yang diperbaiki modul ini:
//
// 1. Versi lama hanya menambah SATU siklus (waktu_eksekusi + 86400000).
//    Kalau bot mati tiga hari, jadwal barunya masih tertinggal di masa lalu,
//    sehingga cron mengirim lagi menit berikutnya, dan lagi — user dibanjiri
//    notifikasi untuk hari yang sudah lewat. Sekarang jadwal dimajukan sampai
//    benar-benar berada di masa depan, jadi cukup satu pesan lalu lanjut.
//
// 2. setMonth(getMonth() + 1) pada tanggal 31 Januari menghasilkan 3 Maret,
//    bukan akhir Februari, karena Date meluberkan tanggal yang tidak ada.
//    Sekarang tanggal dijepit ke hari terakhir bulan tujuan, dan tanggal asli
//    tetap dipakai sebagai acuan agar tidak "mengecil" permanen (31 -> 28 -> 28).

/**
 * Pindahkan `d` ke bulan/tahun tertentu sambil menjaga tanggal asli.
 * Tanggal yang tidak ada di bulan tujuan dijepit ke hari terakhir bulan itu.
 * Jam dan menit tidak tersentuh.
 */
function setKeBulan(d, bulan, tanggalAsli, tahun = d.getFullYear()) {
    d.setDate(1); // cegah luberan sebelum bulan diganti
    d.setFullYear(tahun, bulan);
    const hariTerakhir = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(tanggalAsli, hariTerakhir));
}

/**
 * Hitung kemunculan berikutnya yang masih di masa depan.
 *
 * @param {number} waktuLama  jadwal yang barusan dieksekusi (epoch ms)
 * @param {string} tipe       'harian' | 'mingguan' | 'bulanan' | 'tahunan'
 * @param {number} sekarang   acuan waktu (epoch ms)
 * @returns {number|null}     epoch ms berikutnya, atau null bila tidak berulang
 */
function hitungJadwalBerikutnya(waktuLama, tipe, sekarang) {
    const asal = new Date(waktuLama);
    if (isNaN(asal.getTime())) return null;

    const tanggalAsli = asal.getDate();
    const bulanAsli = asal.getMonth();

    const d = new Date(waktuLama);

    const majuSatuSiklus = {
        harian: () => d.setDate(d.getDate() + 1),
        mingguan: () => d.setDate(d.getDate() + 7),
        bulanan: () => setKeBulan(d, d.getMonth() + 1, tanggalAsli),
        tahunan: () => setKeBulan(d, bulanAsli, tanggalAsli, d.getFullYear() + 1)
    }[tipe];

    if (!majuSatuSiklus) return null; // tipe 'sekali' atau nilai tak dikenal

    // Batas putaran sebagai jaring pengaman supaya tidak pernah jadi loop
    // tak terbatas kalau ada data waktu yang aneh di database.
    let putaran = 0;
    while (d.getTime() <= sekarang && putaran < 10000) {
        majuSatuSiklus();
        putaran += 1;
    }

    return d.getTime() > sekarang ? d.getTime() : null;
}

module.exports = { hitungJadwalBerikutnya };
