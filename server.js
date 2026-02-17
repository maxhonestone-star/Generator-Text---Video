// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const multer = require('multer');

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Koneksi MongoDB (gunakan Atlas)
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB error:', err));

// Schema untuk menyimpan riwayat (opsional)
const historySchema = new mongoose.Schema({
  type: { type: String, enum: ['description', 'generation'] },
  inputImage: { type: String }, // base64 atau url
  prompt: String,
  result: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

// ============= ENDPOINT DESKRIPSI =============
app.post('/api/describe', upload.none(), async (req, res) => {
  try {
    const { image } = req.body; // base64 tanpa header
    if (!image) return res.status(400).json({ error: 'Image required' });

    // Panggil Gemini API dengan API Key dari environment
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) return res.status(500).json({ error: 'Gemini API key not configured' });

    const prompt = `Deskripsikan gambar ini dengan detail. 
ATURAN: 
1. JANGAN sebut detail wajah (etnis, rambut, kumis, jenggot). 
2. BOLEH sebut ekspresi. 
3. Setelah subjek tambahkan "(gambar referensi)". 
4. Gunakan bahasa Indonesia.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
      {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: image } }
          ]
        }]
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (!response.data.candidates || !response.data.candidates[0]) {
      throw new Error('Gagal mendapat respons dari Gemini');
    }

    let description = response.data.candidates[0].content.parts[0].text;

    // Filter tambahan (pastikan aturan terpenuhi)
    description = enforceRules(description);

    // Simpan ke MongoDB (opsional)
    await History.create({
      type: 'description',
      inputImage: image.substring(0, 100), // simpan potongan saja
      result: description
    });

    res.json({ description });

  } catch (error) {
    console.error('Describe error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============= ENDPOINT GENERATE =============
app.post('/api/generate', upload.none(), async (req, res) => {
  try {
    const { image, prompt } = req.body;
    if (!image || !prompt) return res.status(400).json({ error: 'Image and prompt required' });

    const replicateKey = process.env.REPLICATE_API_TOKEN;
    if (!replicateKey) return res.status(500).json({ error: 'Replicate token not configured' });

    // Panggil Replicate API (Stable Diffusion 3.5)
    const replicateResponse = await axios.post(
      'https://api.replicate.com/v1/predictions',
      {
        version: 'stability-ai/stable-diffusion-3.5-large', // atau versi terbaru
        input: {
          image: `data:image/jpeg;base64,${image}`,
          prompt: prompt,
          negative_prompt: 'low quality, blurry',
          num_outputs: 1,
          num_inference_steps: 30,
          guidance_scale: 7.5
        }
      },
      {
        headers: {
          'Authorization': `Token ${replicateKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const prediction = replicateResponse.data;
    const predictionId = prediction.id;

    // Polling sampai selesai (sederhana, bisa pakai webhook nanti)
    let result;
    for (let i = 0; i < 30; i++) { // max 30 detik
      await new Promise(resolve => setTimeout(resolve, 1000));
      const statusResponse = await axios.get(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: { 'Authorization': `Token ${replicateKey}` }
      });
      result = statusResponse.data;
      if (result.status === 'succeeded') break;
      if (result.status === 'failed') throw new Error('Generate gagal');
    }

    if (!result || !result.output) throw new Error('Generate timeout atau gagal');

    const imageUrl = result.output[0];

    // Simpan ke MongoDB (opsional)
    await History.create({
      type: 'generation',
      inputImage: image.substring(0, 100),
      prompt: prompt,
      result: { imageUrl }
    });

    res.json({ imageUrl });

  } catch (error) {
    console.error('Generate error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mongodb: mongoose.connection.readyState === 1 });
});

// Fungsi bantu untuk enforce rules
function enforceRules(text) {
  const banned = ['etnis', 'ras', 'rambut', 'kumis', 'jenggot', 'janggut', 'brewok', 'alis', 'bulu mata', 'warna kulit', 'kulit hitam', 'kulit putih'];
  let filtered = text;
  banned.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    filtered = filtered.replace(regex, '');
  });
  if (!filtered.includes('(gambar referensi)')) {
    const match = filtered.match(/^(seorang|seekor|seseorang|sekelompok)\s+(\w+)/i);
    if (match) {
      filtered = filtered.replace(match[0], match[0] + ' "(gambar referensi)"');
    } else {
      filtered = '(gambar referensi) ' + filtered;
    }
  }
  return filtered;
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});