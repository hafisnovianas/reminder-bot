const { parseJadwalWithAI } = require('./lib/ai-parser');

async function runTests() {
    console.log("Memulai pengujian Groq AI Parser...\n");

    const waktuSekarang = new Date();
    console.log("Waktu Patokan (WIB):", waktuSekarang.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }));
    
    const testCases = [
        "besok jam 3 sore ingatkan anak saya les MTK",
        "Tambahkan pengingat jadwal TST GO untuk sabrina hari jumat 18 september 2026 pukul 15.30",
        "ingatkan untuk bayar tagihan air setiap bulan tanggal 5 jam 9 pagi",
        "halo bot, apa kabar? kamu bisa ngapain aja?"
    ];

    for (let i = 0; i < testCases.length; i++) {
        console.log(`\n---------------------------------`);
        console.log(`Test ${i + 1} Input :`, testCases[i]);
        console.log(`Menunggu AI (delay Queue akan terlihat jika cepat)...`);
        
        try {
            const result = await parseJadwalWithAI(testCases[i], waktuSekarang);
            console.log("Output JSON   :\n", JSON.stringify(result, null, 2));
        } catch (e) {
            console.error("Gagal:", e.message);
        }
    }
    
    console.log(`\n---------------------------------`);
    console.log("Semua pengujian selesai!");
    process.exit(0);
}

runTests();
