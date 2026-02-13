# Noa Live

Realtime voice AI assistant using Next.js + Gemini Live API.

## Production Highlights
- Gemini API key stays server-side.
- Browser receives short-lived ephemeral tokens from `/api/token`.
- Works on Vercel without a custom relay host.
- Origin allowlist enforcement for token issuance in production.
- Token issuance protection with per-IP/global rate limiting and in-flight caps.
- Automatic client retry/backoff for temporary `429`/`503` spikes.
- Security response headers from `next.config.mjs`.

## Requirements
- Node.js 20+
- npm 10+

## Setup
1. Copy `.env.example` to `.env.local`.
2. Set `GEMINI_API_KEY`.
3. For production, set `NOA_ALLOWED_ORIGINS` to exact origins.

## Environment Variables
- `GEMINI_API_KEY` (required): Gemini Developer API key.
- `NOA_ALLOWED_ORIGINS` (required in production): comma-separated exact origins allowed to call `/api/token`.
- `NOA_MODEL` (optional): Gemini model name.
- `NOA_DEFAULT_VOICE` (optional): default voice name.
- `NOA_TOKEN_RATE_WINDOW_MS` (optional, default `60000`): token rate limit window size.
- `NOA_TOKEN_RATE_LIMIT_PER_IP` (optional, default `12`): max `/api/token` requests per IP per window.
- `NOA_TOKEN_RATE_LIMIT_GLOBAL` (optional, default `300`): max total `/api/token` requests per window per server instance.
- `NOA_TOKEN_MAX_INFLIGHT` (optional, default `120`): max concurrent token generation requests per server instance.

## Run
- Development: `npm run dev`
- Production:
  1. `npm run build`
  2. `npm run start`

Or one command:
- `npm run start:prod`

## Vercel Deployment
1. Import repo into Vercel.
2. Set env vars in Vercel project:
   - `GEMINI_API_KEY=...`
   - `NOA_ALLOWED_ORIGINS=https://your-project.vercel.app`
3. Deploy.

Notes:
- Do not include trailing `/` in `NOA_ALLOWED_ORIGINS`.
- Use your custom domain origin too if applicable, comma-separated.

## Docker
Build:
- `docker build -t noa-live:latest .`

Run:
- `docker run --rm -p 3000:3000 -e GEMINI_API_KEY=... -e NOA_ALLOWED_ORIGINS=https://your-domain.com noa-live:latest`

## Production Checklist
1. Rotate any previously exposed API keys.
2. Set `NOA_ALLOWED_ORIGINS` (required in production).
3. Serve over HTTPS.
4. Tune token rate limits for expected traffic and monitor repeated `429`, `503`, and `500` errors.
