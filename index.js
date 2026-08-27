const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const app = express();
app.use(express.json({ limit: '50mb' }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'CleanWave server running' });
});

app.post('/transcribe', async (req, res) => {
  try {
    const { audioUrl, bannedWords } = req.body;
    if (!audioUrl) return res.status(400).json({ error: 'No audio URL provided' });

    const audioResponse = await fetch(audioUrl, {
      headers: { 'Range': 'bytes=0-500000' }
    });
    const audioBuffer = await audioResponse.buffer();

    const formData = new FormData();
    formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    const result = await whisperResponse.json();

    if (!result.words) return res.json({ muteTimestamps: [] });

    const muteTimestamps = [];
    const banned = (bannedWords || []).map(w => w.toLowerCase().replace(/\*/g, '').replace(/\[.*?\]/g, '').trim());

    for (const word of result.words) {
      const clean = word.word.toLowerCase().replace(/[^a-z]/g, '');
      const isBanned = banned.some(b => b.length > 2 && (clean === b || clean.includes(b)));
      if (isBanned) {
        muteTimestamps.push({ start: word.start, end: word.end, word: '***' });
      }
    }

    res.json({ muteTimestamps });
  } catch (e) {
    console.error('Transcribe error:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CleanWave server running on port ${PORT}`));
