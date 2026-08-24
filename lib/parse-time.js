// ========================================================
// PENERJEMAH WAKTU PINTAR (SMART TIME PARSER)
// ========================================================
// Pendekatan: normalisasi teks dulu, lalu PINDAI sinyal waktu
// di posisi mana pun dalam kalimat (bukan mencocokkan pola utuh).
// Dengan begitu kata tambahan seperti "buat", "tolong", atau
// "nanti" tidak lagi membuat seluruh input ditolak.
//
// Nilai balik:
//   { type: 'exact', date: Date }                  -> berhasil, tidak ambigu
//   { type: 'ambiguous', candidates: [Date, Date] } -> jam polos 1-12, dua tafsiran sama-sama masuk akal
//   null                                            -> tidak dikenali
// ========================================================

// Jam default untuk tiap bagian hari (dipakai saat user tidak menyebut angka)
const BAGIAN_HARI = {
    subuh: { jam: 5, mulai: 3, akhir: 6 },
    pagi: { jam: 6, mulai: 5, akhir: 11 },
    siang: { jam: 12, mulai: 11, akhir: 14 },
    sore: { jam: 15, mulai: 15, akhir: 18 },
    malam: { jam: 19, mulai: 18, akhir: 23 }
};

const NAMA_HARI = {
    minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6, ahad: 0
};

const NAMA_BULAN = {
    januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
    juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, agu: 7, ags: 7,
    sep: 8, sept: 8, okt: 9, nov: 10, des: 11
};

const JAM_DEFAULT_TANPA_WAKTU = 8; // "besok" tanpa jam -> besok 08:00

// Kata yang tidak membawa informasi waktu sama sekali. Dibuang agar
// tidak mengganggu pencocokan. "nanti" ikut dibuang karena maknanya
// ("hari ini, kemudian") sudah jadi perilaku default parser.
const KATA_SAMPAH = [
    'tolong', 'ingatkan', 'ingetin', 'ingat', 'reminder', 'remind',
    'buatkan', 'buat', 'bikin', 'set', 'atur', 'pasang',
    'saya', 'aku', 'gue', 'gw', 'kita', 'nya',
    'untuk', 'utk', 'pada', 'pd', 'di', 'ke', 'yang', 'yg',
    'mau', 'ingin', 'pengen', 'pen', 'harus', 'akan',
    'ya', 'yaa', 'dong', 'donk', 'aja', 'saja', 'sih', 'deh', 'kok', 'nih', 'tuh',
    'please', 'plis', 'pls', 'ok', 'oke', 'okay'
];

// Varian penulisan -> bentuk baku
const NORMALISASI = [
    [/\bjum'?at\b/g, 'jumat'],
    [/\bjum'?aat\b/g, 'jumat'],
    [/\bmalem\b/g, 'malam'],
    [/\bsiank\b/g, 'siang'],
    [/\bbsk\b/g, 'besok'],
    [/\besok\b/g, 'besok'],
    [/\bbesuk\b/g, 'besok'],
    [/\bmnt\b/g, 'menit'],
    [/\bmenitan\b/g, 'menit'],
    [/\bmnit\b/g, 'menit'],
    [/\bjm\b/g, 'jam'],
    [/\bhr\b/g, 'hari'],
    [/\bdtk\b/g, 'detik'],
    [/\bdet\b/g, 'detik'],
    [/\bmgg\b/g, 'minggu'],
    [/\bmggu\b/g, 'minggu'],
    [/\bpkl\b/g, 'pukul'],
    [/\bstgh\b/g, 'setengah'],
    [/\btgh\b/g, 'setengah'],
    [/\bhr\s+ini\b/g, 'hari ini'],
    [/\bskrg\b/g, 'sekarang'],
    [/\bskrng\b/g, 'sekarang']
];

/**
 * Rapikan teks mentah: lowercase, samakan varian tulis, buang kata sampah.
 */
function normalisasi(text) {
    let s = String(text || '').toLowerCase();

    // Samakan tanda pemisah jam yang aneh, dan rapikan spasi
    s = s.replace(/\s+/g, ' ').trim();

    // Buang huruf perintah "i" / kata "ingatkan" di awal kalimat
    s = s.replace(/^(i|ingatkan|ingetin)\b\s*/, '');

    for (const [pola, ganti] of NORMALISASI) {
        s = s.replace(pola, ganti);
    }

    // Buang kata sampah, tapi JANGAN sentuh angka & satuan waktu
    const kataSampahSet = new Set(KATA_SAMPAH);
    s = s
        .split(' ')
        .filter((kata) => !kataSampahSet.has(kata.replace(/[.,!?]+$/, '')))
        .join(' ');

    // "nanti" hanya berarti "kemudian" -> tidak membawa info, buang.
    // Dilakukan setelah split agar "nanti malam" tetap menyisakan "malam".
    s = s.replace(/\bnanti\b/g, ' ');

    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Cari durasi (hitung mundur dari sekarang).
 * Aturan pembeda: ANGKA SEBELUM SATUAN = durasi ("2 jam"),
 * sedangkan "jam" sebelum angka = jam dinding ("jam 2").
 */
function cariDurasi(s) {
    const pola = /(\d+(?:[.,]\d+)?)\s*(detik|menit|jam|hari|minggu|bulan)\b/;
    const m = s.match(pola);
    if (!m) return null;

    // Kalau tepat sebelum angka ada kata "jam"/"pukul", ini jam dinding
    // ("jam 2"), bukan durasi. Cek teks sebelum posisi match.
    const sebelum = s.slice(0, m.index).trim();
    if (/\b(jam|pukul)$/.test(sebelum)) return null;

    // "2 minggu depan" tetap durasi; "minggu depan" ditangani cariOffsetHari
    const nilai = parseFloat(m[1].replace(',', '.'));
    if (!isFinite(nilai) || nilai <= 0) return null;

    const ms = {
        detik: 1000,
        menit: 60000,
        jam: 3600000,
        hari: 86400000,
        minggu: 604800000,
        bulan: 2592000000 // 30 hari
    }[m[2]];

    return { ms: Math.round(nilai * ms) };
}

/**
 * Cari keterangan hari: hari ini / besok / lusa / minggu depan / nama hari.
 * Mengembalikan { offsetHari } atau null.
 */
function cariOffsetHari(s, now) {
    if (/\bhari ini\b|\bsekarang\b/.test(s)) return { offsetHari: 0, eksplisit: true };
    if (/\blusa\b/.test(s)) return { offsetHari: 2, eksplisit: true };
    if (/\bbesok\b/.test(s)) return { offsetHari: 1, eksplisit: true };

    // "minggu depan" = +7 hari. Hanya bila TIDAK didahului angka (itu durasi).
    const mingguDepan = s.match(/(\d+\s*)?\bminggu depan\b/);
    if (mingguDepan && !mingguDepan[1]) return { offsetHari: 7, eksplisit: true };

    // Nama hari -> kemunculan berikutnya ("senin" di hari Senin = Senin depan)
    const hari = s.match(/\b(senin|selasa|rabu|kamis|jumat|sabtu|minggu|ahad)\b/);
    if (hari) {
        // "2 minggu" adalah durasi, bukan hari Ahad -> sudah ditangkap cariDurasi
        const sebelum = s.slice(0, hari.index).trim();
        if (hari[1] === 'minggu' && /\d+$/.test(sebelum)) return null;

        const target = NAMA_HARI[hari[1]];
        let selisih = (target - now.getDay() + 7) % 7;
        if (selisih === 0) selisih = 7;
        return { offsetHari: selisih, eksplisit: true };
    }

    return null;
}

/**
 * Cari kata bagian hari (pagi/siang/sore/malam/subuh).
 */
function cariBagianHari(s) {
    if (/\btengah malam\b/.test(s)) return { nama: 'tengah malam', jam: 0 };
    if (/\bdini hari\b/.test(s)) return { nama: 'dini hari', jam: 1 };
    for (const nama of ['subuh', 'pagi', 'siang', 'sore', 'malam']) {
        if (new RegExp(`\\b${nama}\\b`).test(s)) return { nama, ...BAGIAN_HARI[nama] };
    }
    return null;
}

/**
 * Terapkan bagian hari ke jam 12-jam -> 24 jam.
 */
function terapkanBagianHari(jam, bagian) {
    if (!bagian) return jam;
    if (jam > 12) return jam; // sudah format 24 jam, mis. "19 malam"

    switch (bagian.nama) {
        case 'tengah malam':
        case 'dini hari':
        case 'subuh':
        case 'pagi':
            return jam === 12 ? 0 : jam; // "12 pagi" = tengah malam
        case 'siang':
            // "1 siang" -> 13, tapi "11 siang" tetap 11
            return jam >= 10 ? jam : jam + 12;
        case 'sore':
            return jam === 12 ? 12 : jam + 12;
        case 'malam':
            // "12 malam" = tengah malam; "1/2/3 malam" = dini hari
            if (jam === 12) return 0;
            return jam <= 3 ? jam : jam + 12;
        default:
            return jam;
    }
}

/**
 * Cari jam dinding. Mengembalikan { jam, menit, pakai12Jam } atau null.
 * pakai12Jam = true bila angka jam 1-12 tanpa penanda 24-jam,
 * sehingga bisa jadi ambigu (pagi vs malam).
 */
function cariJamDinding(s) {
    // "setengah 8" -> 07:30
    let m = s.match(/\bsetengah\s*(\d{1,2})\b/);
    if (m) {
        const angka = parseInt(m[1], 10);
        const jam = (angka - 1 + 24) % 24;
        return { jam, menit: 30, pakai12Jam: angka >= 1 && angka <= 12 };
    }

    // "7 am" / "7pm" / "7.30 pm"
    m = s.match(/\b(\d{1,2})(?:[:.](\d{1,2}))?\s*(am|pm)\b/);
    if (m) {
        let jam = parseInt(m[1], 10);
        const menit = m[2] ? parseInt(m[2], 10) : 0;
        if (jam > 12) return null;
        if (m[3] === 'pm' && jam < 12) jam += 12;
        if (m[3] === 'am' && jam === 12) jam = 0;
        return { jam, menit, pakai12Jam: false };
    }

    // Jam + menit: "07:00", "7.00", "jam 7.30" -> HH:MM
    // Menulis menit secara lengkap = notasi 24 jam, jadi tidak dianggap ambigu.
    m = s.match(/\b(\d{1,2})[:.](\d{2})\b/);
    if (m) {
        const jam = parseInt(m[1], 10);
        const menit = parseInt(m[2], 10);
        if (jam > 23 || menit > 59) return null;
        return { jam, menit, pakai12Jam: false };
    }

    // Jam saja setelah penanda: "jam 7", "pukul 19"
    m = s.match(/\b(?:jam|pukul)\s*(\d{1,2})\b(?!\s*[:.]\d)/);
    if (m) {
        const jam = parseInt(m[1], 10);
        if (jam > 23) return null;
        return { jam, menit: 0, pakai12Jam: jam >= 1 && jam <= 12 };
    }

    // Angka telanjang bersama bagian hari: "7 pagi", "8 malam", "3 sore"
    m = s.match(/\b(\d{1,2})\s*(?:pagi|siang|sore|malam|subuh)\b/);
    if (m) {
        const jam = parseInt(m[1], 10);
        if (jam > 23) return null;
        return { jam, menit: 0, pakai12Jam: jam >= 1 && jam <= 12 };
    }

    // Balasan angka polos ("7") saat bot bertanya kapan -> jam dinding
    m = s.match(/^(\d{1,2})$/);
    if (m) {
        const jam = parseInt(m[1], 10);
        if (jam > 23) return null;
        return { jam, menit: 0, pakai12Jam: jam >= 1 && jam <= 12 };
    }

    return null;
}

/**
 * Cari tanggal eksplisit: 25/08/2026, 5-9-26, 5/9, "25 agustus".
 * Mengembalikan { tanggal, bulan, tahun } atau null.
 */
function cariTanggal(s, now) {
    // DD/MM/YYYY, DD-MM-YY, DD/MM
    let m = s.match(/\b(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{2,4}))?\b/);
    if (m) {
        const tanggal = parseInt(m[1], 10);
        const bulan = parseInt(m[2], 10) - 1;
        if (tanggal < 1 || tanggal > 31 || bulan < 0 || bulan > 11) return null;

        let tahun = now.getFullYear();
        if (m[3]) {
            tahun = parseInt(m[3], 10);
            if (tahun < 100) tahun += 2000;
        }
        return { tanggal, bulan, tahun, adaTahun: Boolean(m[3]) };
    }

    // "25 agustus" / "25 agustus 2026"
    m = s.match(/\b(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/);
    if (m && Object.prototype.hasOwnProperty.call(NAMA_BULAN, m[2])) {
        const tanggal = parseInt(m[1], 10);
        if (tanggal < 1 || tanggal > 31) return null;
        return {
            tanggal,
            bulan: NAMA_BULAN[m[2]],
            tahun: m[3] ? parseInt(m[3], 10) : now.getFullYear(),
            adaTahun: Boolean(m[3])
        };
    }

    return null;
}

/**
 * Bangun Date dari komponen, aman dari nilai di luar rentang.
 */
function buatDate(now, { offsetHari = 0, jam, menit = 0, tanggal = null }) {
    const d = new Date(now.getTime());
    if (tanggal) {
        d.setFullYear(tanggal.tahun, tanggal.bulan, tanggal.tanggal);
    } else if (offsetHari) {
        d.setDate(d.getDate() + offsetHari);
    }
    d.setHours(jam, menit, 0, 0);
    return d;
}

/**
 * Terjemahkan teks waktu kasual menjadi Date.
 * @param {string} text  input mentah dari user
 * @param {Date}  [now]  waktu acuan (di-inject saat test)
 */
function parseSmartTime(text, now = new Date()) {
    const s = normalisasi(text);
    if (!s) return null;

    // --- 1. Durasi (hitung mundur) menang bila tidak ada jam dinding ---
    const durasi = cariDurasi(s);
    const jamDinding = cariJamDinding(s);

    if (durasi && !jamDinding) {
        return { type: 'exact', date: new Date(now.getTime() + durasi.ms) };
    }

    const tanggal = cariTanggal(s, now);
    const offsetHari = cariOffsetHari(s, now);
    const bagianHari = cariBagianHari(s);

    // --- 2. Tidak ada sinyal waktu sama sekali ---
    if (!jamDinding && !tanggal && !offsetHari && !bagianHari) return null;

    // --- 3. Tentukan jam & menit ---
    let jam;
    let menit = 0;
    let ambigu = false;

    if (jamDinding) {
        menit = jamDinding.menit;
        if (bagianHari) {
            jam = terapkanBagianHari(jamDinding.jam, bagianHari);
        } else {
            jam = jamDinding.jam;
            // Jam polos 1-12 tanpa penanda pagi/malam -> berpotensi ambigu
            ambigu = jamDinding.pakai12Jam;
        }
    } else if (bagianHari) {
        jam = bagianHari.jam;
    } else {
        jam = JAM_DEFAULT_TANPA_WAKTU; // "besok" / "25/08" tanpa jam
    }

    if (jam > 23 || menit > 59) return null;

    // --- 4. Tanggal eksplisit: hasil pasti, tidak pernah digeser ---
    if (tanggal) {
        const d = buatDate(now, { jam, menit, tanggal });
        // Tahun tidak disebut & tanggalnya sudah lewat -> maksudnya tahun depan
        if (!tanggal.adaTahun && d.getTime() <= now.getTime()) {
            d.setFullYear(d.getFullYear() + 1);
        }
        return { type: 'exact', date: d };
    }

    // --- 5. User menyebut hari secara eksplisit -> jangan digeser ---
    if (offsetHari) {
        const d = buatDate(now, { offsetHari: offsetHari.offsetHari, jam, menit });

        // "hari ini jam 7" padahal jam 7 sudah lewat: tetap hormati "hari ini",
        // biarkan pemanggil yang menolak dengan pesan "waktu sudah berlalu".
        if (ambigu) {
            const alternatif = buatDate(now, { offsetHari: offsetHari.offsetHari, jam: jam + 12, menit });
            if (jam + 12 <= 23 && d.getTime() > now.getTime() && alternatif.getTime() > now.getTime()) {
                return { type: 'ambiguous', candidates: [d, alternatif].sort((a, b) => a - b) };
            }
            // Salah satu sudah lewat -> pilih yang masih di masa depan
            if (d.getTime() <= now.getTime() && jam + 12 <= 23 && alternatif.getTime() > now.getTime()) {
                return { type: 'exact', date: alternatif };
            }
        }
        return { type: 'exact', date: d };
    }

    // --- 6. Tanpa keterangan hari: hari ini, geser ke besok bila sudah lewat ---
    const pagiHari = buatDate(now, { jam, menit });
    if (ambigu && jam + 12 <= 23) {
        const soreHari = buatDate(now, { jam: jam + 12, menit });

        // Ambil versi terdekat yang belum lewat untuk masing-masing tafsiran
        if (pagiHari.getTime() <= now.getTime()) pagiHari.setDate(pagiHari.getDate() + 1);
        if (soreHari.getTime() <= now.getTime()) soreHari.setDate(soreHari.getDate() + 1);

        if (pagiHari.getTime() !== soreHari.getTime()) {
            return { type: 'ambiguous', candidates: [pagiHari, soreHari].sort((a, b) => a - b) };
        }
        return { type: 'exact', date: pagiHari };
    }

    if (pagiHari.getTime() <= now.getTime()) pagiHari.setDate(pagiHari.getDate() + 1);
    return { type: 'exact', date: pagiHari };
}

module.exports = { parseSmartTime };
