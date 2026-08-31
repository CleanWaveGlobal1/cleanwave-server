const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { Pool } = require('pg');
const app = express();
app.use(express.json({ limit: '50mb' }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id SERIAL PRIMARY KEY,
        episode_url TEXT UNIQUE NOT NULL,
        mute_timestamps JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Database ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

initDB();

app.get('/health', (req, res) => {
  res.json({ status: 'CleanWave server running' });
});

async function fetchAudioBuffer(url, startByte, endByte) {
  const cleanUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const response = await fetch(cleanUrl, {
    redirect: 'follow',
    headers: {
      'Range': `bytes=${startByte}-${endByte}`,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
    }
  });
  console.log('Audio status:', response.status);
  return await response.buffer();
}

app.post('/transcribe', async (req, res) => {
  try {
    const { audioUrl, bannedWords, startSeconds = 0 } = req.body;
    console.log('Transcribe request:', audioUrl?.substring(0, 80));

    if (!audioUrl) return res.status(400).json({ error: 'No audio URL provided' });

    const cleanUrl = audioUrl.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const cacheKey = `${cleanUrl}_${startSeconds}`;

    const cached = await pool.query(
      'SELECT mute_timestamps FROM transcripts WHERE episode_url = $1',
      [cacheKey]
    );

    if (cached.rows.length > 0) {
      console.log('Cache hit! Returning cached timestamps');
      return res.json({ muteTimestamps: cached.rows[0].mute_timestamps, cached: true });
    }

    console.log('Cache miss - processing with Whisper');

    const startByte = Math.floor(startSeconds * 16000);
    const endByte = startByte + 2000000;

    const audioBuffer = await fetchAudioBuffer(cleanUrl, startByte, endByte);
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

    console.log('Sending to Whisper...');
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

    await pool.query(
      'INSERT INTO transcripts (episode_url, mute_timestamps) VALUES ($1, $2) ON CONFLICT (episode_url) DO UPDATE SET mute_timestamps = $2',
      [cacheKey, JSON.stringify(muteTimestamps)]
    );
    console.log('Cached to database');

    res.json({ muteTimestamps });

  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message, muteTimestamps: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CleanWave server running on port ${PORT}`));
