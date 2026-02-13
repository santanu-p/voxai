# VoxAI

Realtime voice AI assistant using Next.js + Gemini Live API.

## Production Highlights
- Gemini API key stays server-side.
- Browser receives short-lived ephemeral tokens from `/api/token`.
- Works on Vercel without a custom relay host.
- Origin allowlist enforcement for token issuance in production.
- Security response headers from `next.config.mjs`.

## Requirements
- Node.js 20+
- npm 10+

## Setup
1. Copy `.env.example` to `.env.local`.
2. Set `GEMINI_API_KEY`.
3. For production, set `VOXAI_ALLOWED_ORIGINS` to exact origins.

## Environment Variables
- `GEMINI_API_KEY` (required): Gemini Developer API key.
- `VOXAI_ALLOWED_ORIGINS` (required in production): comma-separated exact origins allowed to call `/api/token`.
- `VOXAI_MODEL` (optional): Gemini model name.
- `VOXAI_DEFAULT_VOICE` (optional): default voice name.

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
   - `VOXAI_ALLOWED_ORIGINS=https://your-project.vercel.app`
3. Deploy.

Notes:
- Do not include trailing `/` in `VOXAI_ALLOWED_ORIGINS`.
- Use your custom domain origin too if applicable, comma-separated.

## Docker
Build:
- `docker build -t voxai:latest .`

Run:
- `docker run --rm -p 3000:3000 -e GEMINI_API_KEY=... -e VOXAI_ALLOWED_ORIGINS=https://your-domain.com voxai:latest`

## Production Checklist
1. Rotate any previously exposed API keys.
2. Set `VOXAI_ALLOWED_ORIGINS` (required in production).
3. Serve over HTTPS.
4. Monitor logs for repeated token endpoint errors (`403`, `500`).
