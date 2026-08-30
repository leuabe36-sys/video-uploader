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
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

app.set('trust proxy', 1); // needed on Render so req.protocol/host are correct behind their proxy

// Resolve the base URL once, preferring the explicit env var but falling back
// to whatever the request came in on — one less thing you have to configure by hand.
function resolveBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Which required env vars are missing, grouped by provider. Checked on every
// OAuth attempt so we can show a clear in-app message instead of letting
// Google/TikTok show their own generic "invalid_request" error page.
function getConfigStatus() {
  const missingGoogle = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter((k) => !process.env[k]);
  const missingTiktok = ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'].filter((k) => !process.env[k]);
  return {
    google: { configured: missingGoogle.length === 0, missing: missingGoogle },
    tiktok: { configured: missingTiktok.length === 0, missing: missingTiktok },
  };
}

function missingVarsPage(providerName, missingVars, req) {
  const baseUrl = resolveBaseUrl(req);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Setup needed</title>
  <style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#222;line-height:1.5}
  code{background:#f2f2f2;padding:2px 6px;border-radius:4px}h1{font-size:20px}a{color:#fe2c55}</style></head>
  <body>
  <h1>${providerName} isn't configured yet</h1>
  <p>This app is missing the following environment variable(s) on the server:</p>
  <ul>${missingVars.map((v) => `<li><code>${v}</code></li>`).join('')}</ul>
  <p>Add them in your host's Environment settings (e.g. Render → your service → Environment tab), then redeploy.</p>
  <p>Once set, make sure your ${providerName} app's redirect URI is exactly:<br>
  <code>${baseUrl}/auth/${providerName.toLowerCase()}/callback</code></p>
  <p><a href="/">← Back to app</a></p>
  </body></html>`;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true, // refresh expiry on every request, so an active user stays logged in
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — avoids re-login every session
    },
  })
);

// ---------- Google OAuth ----------
function getOAuthClient(req) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${resolveBaseUrl(req)}/auth/google/callback`
  );
}

app.get('/auth/google', (req, res) => {
  const status = getConfigStatus();
  if (!status.google.configured) {
    return res.status(500).send(missingVarsPage('Google', status.google.missing, req));
  }
  const oauth2Client = getOAuthClient(req);
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  if (req.query.error) {
    return res.status(400).send(`Google sign-in was cancelled or denied (${req.query.error}). <a href="/">Try again</a>`);
  }
  try {
    const oauth2Client = getOAuthClient(req);
    const { tokens } = await oauth2Client.getToken(req.query.code);
    req.session.googleTokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.status(500).send(`Google auth failed: ${err.message}. Double-check your redirect URI matches exactly in Google Cloud Console. <a href="/">Back</a>`);
  }
});

// ---------- TikTok OAuth ----------
// Docs: https://developers.tiktok.com/doc/login-kit-web
app.get('/auth/tiktok', (req, res) => {
  const status = getConfigStatus();
  if (!status.tiktok.configured) {
    return res.status(500).send(missingVarsPage('TikTok', status.tiktok.missing, req));
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.tiktokState = state;
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    response_type: 'code',
    scope: 'user.info.basic,video.publish,video.upload',
    redirect_uri: `${resolveBaseUrl(req)}/auth/tiktok/callback`,
    state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`TikTok sign-in was cancelled or denied (${error}). <a href="/">Try again</a>`);
  }
  if (!state || state !== req.session.tiktokState) {
    return res.status(400).send('Login session expired or invalid — please try connecting again. <a href="/">Back</a>');
  }
  try {
    const resp = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${resolveBaseUrl(req)}/auth/tiktok/callback`,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    req.session.tiktokTokens = resp.data;
    res.redirect('/');
  } catch (err) {
    console.error('TikTok OAuth error:', err.response?.data || err.message);
    res.status(500).send(`TikTok auth failed: ${JSON.stringify(err.response?.data || err.message)}. Double-check your redirect URI matches exactly in the TikTok Developer dashboard, and that your account is added as a tester if the app is unaudited. <a href="/">Back</a>`);
  }
});

// ---------- Session + config status (frontend uses this to show setup banners) ----------
app.get('/api/status', (req, res) => {
  const config = getConfigStatus();
  res.json({
    google: !!req.session.googleTokens,
    tiktok: !!req.session.tiktokTokens,
    googleConfigured: config.google.configured,
    tiktokConfigured: config.tiktok.configured,
  });
});

// ---------- Sign out ----------
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ---------- List videos from Drive ----------
app.get('/api/drive/videos', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not connected to Google' });
  try {
    const oauth2Client = getOAuthClient(req);
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
    const oauth2Client = getOAuthClient(req);
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
  console.log(`Server listening on port ${PORT}`);
  if (process.env.BASE_URL) {
    console.log(`BASE_URL set explicitly: ${process.env.BASE_URL}`);
  } else {
    console.log('BASE_URL not set — will auto-detect from incoming requests (fine for most setups).');
  }
  const status = getConfigStatus();
  if (!status.google.configured) console.warn(`⚠ Google not configured — missing: ${status.google.missing.join(', ')}`);
  if (!status.tiktok.configured) console.warn(`⚠ TikTok not configured — missing: ${status.tiktok.missing.join(', ')}`);
});
