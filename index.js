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
    const { audioUrl, bannedWords, startSeconds = 0 } = req.body;
    console.log('Transcribe request:', audioUrl);

    if (!audioUrl) return res.status(400).json({ error: 'No audio URL provided' });

    const cleanUrl = audioUrl.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const startByte = Math.floor(startSeconds * 16000);
    const endByte = startByte + 2000000;

    const audioResponse = await fetch(cleanUrl, {
      headers: {
        'Range': `bytes=${startByte}-${endByte}`,
        'User-Agent': 'Mozilla/5.0 CleanWave/1.0'
      }
    });

    console.log('Audio status:', audioResponse.status);
    const audioBuffer = await audioResponse.buffer();
    console.log('Buffer size:', audioBuffer.length);

    if (audioBuffer.length < 1000) {
      return res.json({ muteTimestamps: [] });
    }

    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: 'audio.mp3',
      contentType: 'audio/mpeg'
    });
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
    console.log('Words found:', result.words?.length || 0);

    if (!result.words) {
      console.log('Error:', JSON.stringify(result).substring(0, 200));
      return res.json({ muteTimestamps: [] });
    }

    const banned = (bannedWords || []).map(w =>
      w.replace(/\*/g, '').replace(/\[.*?\]/g, '').toLowerCase().trim()
    ).filter(w => w.length > 0);

    const muteTimestamps = [];
    for (const word of result.words) {
      const clean = word.word.toLowerCase().replace(/[^a-z]/g, '');
      const isBanned = banned.some(b => b.length > 2 && (clean === b || clean.includes(b)));
      if (isBanned) {
        console.log('Banned:', clean, 'at', word.start);
        muteTimestamps.push({ start: word.start, end: word.end, word: '***' });
      }
    }

    console.log('Mute timestamps:', muteTimestamps.length);
    res.json({ muteTimestamps });

  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message, muteTimestamps: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CleanWave server running on port ${PORT}`));
