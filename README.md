# VoxAI

Realtime voice AI assistant using Next.js + a server-side WebSocket relay for Gemini Live.

## Production Highlights
- Gemini API key stays server-side (`server.mjs` relay).
- WebSocket origin allowlist enforcement in production.
- Connection and per-IP limits.
- Message rate limiting.
- Heartbeat + stale connection cleanup.
- Graceful shutdown handling (`SIGINT`/`SIGTERM`).
- Health endpoints (`/healthz`, `/readyz`).
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
- `VOXAI_ALLOWED_ORIGINS` (required in production): comma-separated exact origins allowed to open relay websocket.
- `HOST` (optional, default `0.0.0.0`): bind host.
- `PORT` (optional, default `3000`): bind port.
- `VOXAI_MODEL` (optional): Gemini model name.
- `VOXAI_DEFAULT_VOICE` (optional): default voice name.
- `VOXAI_MAX_PAYLOAD_BYTES` (optional): websocket max payload.
- `VOXAI_MAX_CONNECTIONS` (optional): global active websocket cap.
- `VOXAI_MAX_CONNECTIONS_PER_IP` (optional): per-IP connection cap.
- `VOXAI_MAX_MESSAGES_PER_MINUTE` (optional): per-connection message cap.
- `VOXAI_PING_INTERVAL_MS` (optional): websocket heartbeat interval.
- `VOXAI_START_TIMEOUT_MS` (optional): timeout for initial `start` message after socket open.

## Run
- Development: `npm run dev`
- Production:
  1. `npm run build`
  2. `npm run start`

Or one command:
- `npm run start:prod`

## Docker
Build:
- `docker build -t voxai:latest .`

Run:
- `docker run --rm -p 3000:3000 -e GEMINI_API_KEY=... -e VOXAI_ALLOWED_ORIGINS=https://your-domain.com voxai:latest`

## Health Checks
- Liveness: `GET /healthz`
- Readiness: `GET /readyz`

## Production Checklist
1. Rotate any previously exposed API keys.
2. Set `VOXAI_ALLOWED_ORIGINS` (required in production).
3. Serve over HTTPS.
4. Put behind a reverse proxy/load balancer.
5. Configure process manager (`systemd`, PM2, or container orchestrator).
6. Monitor logs and alert on repeated `429`, `403`, or relay `error` events.
