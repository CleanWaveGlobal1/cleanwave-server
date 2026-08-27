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
    console.log('Received transcribe request for:', audioUrl);
    console.log('Banned words:', bannedWords);

    if (!audioUrl) return res.status(400).json({ error: 'No audio URL provided' });

    console.log('Fetching audio from URL...');
    const audioResponse = await fetch(audioUrl, {
      headers: { 
        'Range': 'bytes=0-2000000',
        'User-Agent': 'CleanWave/1.0'
      }
    });
    
    console.log('Audio response status:', audioResponse.status);
    const audioBuffer = await audioResponse.buffer();
    console.log('Audio buffer size:', audioBuffer.length, 'bytes');

    if (audioBuffer.length < 1000) {
      return res.json({ muteTimestamps: [], error: 'Audio too small' });
    }

    const formData = new FormData();
    formData.append('file', audioBuffer, { 
      filename: 'audio.mp3', 
      contentType: 'audio/mpeg' 
    });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    console.log('Sending to Whisper API...');
    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    const result = await whisperResponse.json();
    console.log('Whisper result:', JSON.stringify(result).substring(0, 500));

    if (!result.words) {
      console.log('No words in result');
      return res.json({ muteTimestamps: [] });
    }

    const muteTimestamps = [];
    const banned = (bannedWords || []).map(w => 
      w.replace(/\*/g, '').replace(/\[.*?\]/g, '').toLowerCase().trim()
    ).filter(w => w.length > 0);

    console.log('Processed banned words:', banned);

    for (const word of result.words) {
      const clean = word.word.toLowerCase().replace(/[^a-z]/g, '');
      const isBanned = banned.some(b => b.length > 2 && (clean === b || clean.includes(b)));
      if (isBanned) {
        console.log('Found banned word:', clean, 'at', word.start, '-', word.end);
        muteTimestamps.push({ start: word.start, end: word.end, word: '***' });
      }
    }

    console.log('Total mute timestamps:', muteTimestamps.length);
    res.json({ muteTimestamps });
  } catch (e) {
    console.error('Transcribe error:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CleanWave server running on port ${PORT}`));
