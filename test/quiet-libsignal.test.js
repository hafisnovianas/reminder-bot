const test = require('node:test');
const assert = require('node:assert');
const { redamLogSesi, saringArgumen } = require('../lib/quiet-libsignal');

/** Tiruan objek yang benar-benar dicetak libsignal, lengkap dengan kunci. */
function sesiPalsu() {
    return {
        registrationId: 464473514,
        currentRatchet: {
            ephemeralKeyPair: {
                pubKey: Buffer.from('05c5b3a1a64fde69', 'hex'),
                privKey: Buffer.from('d068bc1a7a354c59', 'hex')
            },
            rootKey: Buffer.from('9393cf500df4e950', 'hex')
        }
    };
}

// ========================================================
// 1. PENYARINGAN ARGUMEN
// ========================================================
test('baris yang melampirkan objek sesi kehilangan lampirannya', () => {
    for (const prefix of [
        'Closing session:',
        'Opening session:',
        'Removing old closed session:',
        'Session already closed'
    ]) {
        const hasil = saringArgumen([prefix, sesiPalsu()]);
        assert.strictEqual(hasil.length, 1, `"${prefix}" masih membawa lampiran`);
        assert.strictEqual(hasil[0], `${prefix} [objek sesi disembunyikan]`);
    }
});

test('baris console lain tidak tersentuh', () => {
    // Ini berguna dan tidak memuat kunci, jadi harus lewat apa adanya.
    const migrasi = ['Migrating session to:', 'v1'];
    assert.deepStrictEqual(saringArgumen(migrasi), migrasi);

    const biasa = ['Halo', { a: 1 }];
    assert.deepStrictEqual(saringArgumen(biasa), biasa);

    // Argumen pertama bukan string -> jangan diapa-apakan
    const objekSaja = [{ b: 2 }];
    assert.deepStrictEqual(saringArgumen(objekSaja), objekSaja);

    assert.deepStrictEqual(saringArgumen([]), []);
});

// ========================================================
// 2. BUKTI UJUNG-KE-UJUNG: TIDAK ADA KUNCI YANG SAMPAI KE STDOUT
// ========================================================
test('setelah diredam, private key tidak pernah muncul di keluaran', () => {
    redamLogSesi();

    const sesi = sesiPalsu();
    const privKeyHex = sesi.currentRatchet.ephemeralKeyPair.privKey.toString('hex');
    const rootKeyHex = sesi.currentRatchet.rootKey.toString('hex');

    // Sadap stdout dan stderr untuk menangkap apa yang benar-benar tertulis.
    const tertulis = [];
    const stdoutAsli = process.stdout.write;
    const stderrAsli = process.stderr.write;
    process.stdout.write = (chunk, ...rest) => { tertulis.push(String(chunk)); return true; };
    process.stderr.write = (chunk, ...rest) => { tertulis.push(String(chunk)); return true; };

    try {
        console.info('Closing session:', sesi);
        console.info('Opening session:', sesi);
        console.warn('Session already closed', sesi);
        console.info('Removing old closed session:', sesi);
    } finally {
        process.stdout.write = stdoutAsli;
        process.stderr.write = stderrAsli;
    }

    const keluaran = tertulis.join('');

    assert.ok(!keluaran.includes(privKeyHex), 'private key bocor ke keluaran');
    assert.ok(!keluaran.includes(rootKeyHex), 'root key bocor ke keluaran');
    assert.ok(!keluaran.includes('privKey'), 'nama field privKey masih tercetak');
    assert.ok(!keluaran.includes('registrationId'), 'isi objek sesi masih tercetak');

    // Pesannya sendiri tetap ada, supaya masalah sesi masih bisa dilacak.
    assert.ok(keluaran.includes('Closing session:'), 'pesannya ikut hilang');
    assert.ok(keluaran.includes('[objek sesi disembunyikan]'));
});

test('redamLogSesi aman dipanggil berkali-kali', () => {
    assert.doesNotThrow(() => {
        redamLogSesi();
        redamLogSesi();
        redamLogSesi();
    });

    // Penambalan berulang tidak boleh menumpuk dan merusak console biasa.
    const tertulis = [];
    const asli = process.stdout.write;
    process.stdout.write = (chunk) => { tertulis.push(String(chunk)); return true; };
    try {
        console.info('pesan biasa');
    } finally {
        process.stdout.write = asli;
    }
    assert.ok(tertulis.join('').includes('pesan biasa'));
});
