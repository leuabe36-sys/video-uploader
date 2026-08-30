# Drive → TikTok Uploader

A small full-stack app: connect Google Drive, connect TikTok, pick a video, publish it.

## How it works
1. You sign in with Google → the app can list/download your Drive videos (read-only).
2. You sign in with TikTok → the app gets permission to post on your behalf.
3. You pick a video and hit Publish → the server downloads it from Drive, then uploads it to TikTok via the [Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started/).

## 1. Google setup
1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → Credentials** → Create Credentials → OAuth client ID → type **Web application**.
4. Add authorized redirect URI: `http://localhost:3000/auth/google/callback`
5. Copy the Client ID / Client Secret into `.env`.

## 2. TikTok setup
1. Go to [developers.tiktok.com](https://developers.tiktok.com/) → create an app.
2. Add the **Login Kit** and **Content Posting API** products.
3. Set redirect URI: `http://localhost:3000/auth/tiktok/callback`
4. Copy the Client Key / Client Secret into `.env`.
5. **Important**: new/unaudited TikTok apps can only post as **private drafts** (`SELF_ONLY`), and only for TikTok accounts you've explicitly added as "Target users" / testers in the app dashboard while it's in sandbox mode. To post publicly to any account, TikTok must review and approve your app for the `video.publish` scope in production. This code already sets `privacy_level: "SELF_ONLY"` for that reason — see `server.js` if you later get approved and want to change it.

## 3. Run it
```bash
npm install
cp .env.example .env   # then fill in the values above
npm start
```
Open http://localhost:3000

## Notes / limitations
- TikTok requires HTTPS redirect URIs for anything other than local testing — for a deployed version, use a real domain with HTTPS (e.g. via a reverse proxy or a host like Render/Fly.io), or tunnel locally with `ngrok http 3000` and update both the `.env` `BASE_URL` and the redirect URIs in both consoles.
- Tokens are stored in the server session (in-memory) for simplicity — they'll clear on restart. For production use, persist refresh tokens in a database and add token-refresh logic (Google tokens expire in ~1hr, TikTok access tokens too).
- Only video files are listed from Drive (`mimeType contains 'video/'`).
- Videos are uploaded to TikTok in a single chunk here for simplicity; TikTok requires true multi-chunk PUT requests for files over ~64MB — if you'll be posting large files, that loop needs to be built out (init already returns `total_chunk_count` needed for it).
