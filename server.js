require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

// ---------- Google OAuth ----------
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/google/callback`
  );
}

app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(req.query.code);
    req.session.googleTokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.status(500).send('Google auth failed. Check server logs.');
  }
});

// ---------- TikTok OAuth ----------
// Docs: https://developers.tiktok.com/doc/login-kit-web
app.get('/auth/tiktok', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.tiktokState = state;
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    response_type: 'code',
    scope: 'user.info.basic,video.publish,video.upload',
    redirect_uri: `${BASE_URL}/auth/tiktok/callback`,
    state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!state || state !== req.session.tiktokState) {
    return res.status(400).send('Invalid state parameter.');
  }
  try {
    const resp = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${BASE_URL}/auth/tiktok/callback`,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    req.session.tiktokTokens = resp.data;
    res.redirect('/');
  } catch (err) {
    console.error('TikTok OAuth error:', err.response?.data || err.message);
    res.status(500).send('TikTok auth failed. Check server logs.');
  }
});

// ---------- Session status ----------
app.get('/api/status', (req, res) => {
  res.json({
    google: !!req.session.googleTokens,
    tiktok: !!req.session.tiktokTokens,
  });
});

// ---------- List videos from Drive ----------
app.get('/api/drive/videos', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not connected to Google' });
  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(req.session.googleTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const result = await drive.files.list({
      q: "mimeType contains 'video/' and trashed = false",
      fields: 'files(id, name, mimeType, size, thumbnailLink)',
      pageSize: 25,
      orderBy: 'modifiedTime desc',
    });
    res.json(result.data.files);
  } catch (err) {
    console.error('Drive list error:', err.message);
    res.status(500).json({ error: 'Failed to list Drive videos' });
  }
});

// ---------- Core: download from Drive, then push to TikTok ----------
app.post('/api/publish', async (req, res) => {
  const { fileId, caption } = req.body;
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not connected to Google' });
  if (!req.session.tiktokTokens) return res.status(401).json({ error: 'Not connected to TikTok' });
  if (!fileId) return res.status(400).json({ error: 'fileId is required' });

  const tmpPath = path.join(TMP_DIR, `${fileId}-${Date.now()}.mp4`);

  try {
    // 1. Download the file from Google Drive
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(req.session.googleTokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    const driveRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tmpPath);
      driveRes.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    const videoSize = fs.statSync(tmpPath).size;

    // 2. Initialize the TikTok upload (FILE_UPLOAD source)
    const accessToken = req.session.tiktokTokens.access_token;
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB, per TikTok's recommended chunking
    const chunkCount = Math.max(1, Math.ceil(videoSize / CHUNK_SIZE));

    const initResp = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: caption || '',
          privacy_level: 'SELF_ONLY', // unaudited apps can only post private/draft content
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: videoSize < CHUNK_SIZE ? videoSize : CHUNK_SIZE,
          total_chunk_count: chunkCount,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const { upload_url, publish_id } = initResp.data.data;

    // 3. Upload the video bytes to the URL TikTok gave us
    const videoBuffer = fs.readFileSync(tmpPath);
    await axios.put(upload_url, videoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    fs.unlinkSync(tmpPath);
    res.json({ success: true, publish_id, note: 'Video sent to TikTok as a private draft (SELF_ONLY) — required for unaudited apps.' });
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    console.error('Publish error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at ${BASE_URL}`);
});
