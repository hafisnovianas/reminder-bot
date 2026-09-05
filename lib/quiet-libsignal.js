// ========================================================
// MEREDAM BOCORAN KUNCI SESI KE LOG
// ========================================================
// libsignal (dependensi Baileys) mencetak seluruh objek SessionEntry ke konsol
// pada empat tempat di src/session_record.js. Objek itu memuat privKey,
// rootKey, dan ephemeralKeyPair — material kripto sesi WhatsApp — sehingga
// kunci tersebut mendarat sebagai teks biasa di ~/.pm2/logs dan ikut terbawa
// ke mana pun log itu disalin.
//
// Pemanggilannya tidak bisa dimatikan lewat konfigurasi apa pun: libsignal
// memakai console global secara langsung, bukan logger yang bisa di-inject.
// Menyunting node_modules bukan pilihan karena hilang setiap `npm ci`.
//
// Jadi yang dibungkam bukan pesannya, melainkan lampirannya: baris tetap
// tercetak (masih berguna untuk melacak masalah sesi), objeknya diganti
// penanda. Baris console lain sama sekali tidak tersentuh.
//
// Rujukan: node_modules/libsignal/src/session_record.js:270,273,281,301

const PREFIX_SENSITIF = [
    'Closing session:',
    'Opening session:',
    'Removing old closed session:',
    'Session already closed'
];

/**
 * Saring argumen satu pemanggilan console. Bila baris ini termasuk yang
 * melampirkan objek sesi, kembalikan pesannya saja tanpa lampiran.
 * Dipisah dari penambalan agar bisa diuji langsung.
 */
function saringArgumen(args) {
    const pesan = args[0];
    if (typeof pesan === 'string' && PREFIX_SENSITIF.some((p) => pesan.startsWith(p))) {
        return [`${pesan} [objek sesi disembunyikan]`];
    }
    return args;
}

/**
 * Pasang saringan pada console.info dan console.warn (dua kanal yang dipakai
 * libsignal untuk baris-baris tersebut). Aman dipanggil berkali-kali.
 */
let sudahTerpasang = false;
function redamLogSesi() {
    if (sudahTerpasang) return;
    sudahTerpasang = true;

    for (const metode of ['info', 'warn']) {
        const asli = console[metode].bind(console);
        console[metode] = (...args) => asli(...saringArgumen(args));
    }
}

module.exports = { redamLogSesi, saringArgumen, PREFIX_SENSITIF };
