const Groq = require('groq-sdk');

// Inisialisasi Groq Client
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// PQueue ESM lazy-load workaround
let queue;
async function getQueue() {
    if (!queue) {
        // p-queue v9 adalah modul ESM murni, jadi harus menggunakan dynamic import di CommonJS
        const { default: PQueue } = await import('p-queue');
        
        // Aturan Anti-Limit Groq:
        // Maksimal 30 request per menit = 1 request setiap 2000 ms (2 detik)
        queue = new PQueue({
            intervalCap: 1,
            interval: 2000,
            carryoverConcurrencyCount: true
        });
    }
    return queue;
}

/**
 * Mengekstrak informasi penjadwalan dari teks alami menggunakan Llama 3 8B.
 * 
 * @param {string} pesanTeks Teks chat asli dari user.
 * @param {Date} waktuSekarang Tanggal dan waktu server saat ini (sebagai patokan "besok/lusa").
 * @returns {Promise<Object|null>} Mengembalikan JSON jadwal atau null jika bukan pesan jadwal.
 */
async function parseJadwalWithAI(pesanTeks, waktuSekarang) {
    const aiQueue = await getQueue();
    
    // Antrekan request ini agar tidak terkena Rate Limit 429 dari Groq
    return await aiQueue.add(async () => {
        try {
            const systemPrompt = `Anda adalah asisten ekstraksi jadwal.
Waktu server saat ini adalah: ${waktuSekarang.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} (WIB).

Tugas Anda:
1. Pahami teks pesan dari pengguna.
2. Jika pesan tersebut merupakan permintaan untuk diingatkan/membuat jadwal, keluarkan JSON valid.
3. Jika bukan permintaan pengingat (misal hanya ngobrol atau tanya), kembalikan is_jadwal: false.

Format JSON Wajib:
{
  "is_jadwal": true/false,
  "pesan": "Inti pesan yang akan diingatkan (misal: Rapat Zoom, Bayar Tagihan, TST GO)",
  "tanggal_waktu_iso": "Tanggal dan waktu dalam format ISO8601 (YYYY-MM-DDTHH:mm:ss) sesuai Waktu Indonesia Barat (WIB).",
  "siklus": "sekali" | "harian" | "mingguan" | "bulanan" | "tahunan"
}

Peraturan:
- Hanya balas dengan raw JSON, tanpa markdown \`\`\`json, tanpa penjelasan apapun.
- Untuk 'siklus', default adalah 'sekali' kecuali user eksplisit meminta rutin.
- Jika user tidak menyebutkan tanggal, asumsikan hari ini (jika jam belum lewat) atau besok.
`;

            const completion = await groq.chat.completions.create({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: pesanTeks }
                ],
                model: 'openai/gpt-oss-20b',
                temperature: 0.2, // Rendah agar konsisten output JSON-nya
                response_format: { type: 'json_object' }
            });

            const content = completion.choices[0]?.message?.content;
            if (!content) return null;

            // Parse hasil output ke objek JSON Javascript
            const parsed = JSON.parse(content);
            return parsed;

        } catch (error) {
            console.error('❌ Error API Groq:', error?.error?.message || error.message);
            return null;
        }
    });
}

module.exports = {
    parseJadwalWithAI
};
