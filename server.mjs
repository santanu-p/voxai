import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import next from 'next';
import nextEnv from '@next/env';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const { loadEnvConfig } = nextEnv;

const dev = process.argv.includes('--dev');
process.env.NODE_ENV = dev ? 'development' : 'production';
loadEnvConfig(process.cwd(), dev);
const isProduction = process.env.NODE_ENV === 'production';

const VOICE_ALLOWLIST = new Set(['Aoede', 'Kore', 'Leda', 'Puck', 'Zephyr']);
const CONFIG = {
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 3000),
    model: process.env.VOXAI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025',
    defaultVoice: process.env.VOXAI_DEFAULT_VOICE || 'Aoede',
    maxPayloadBytes: Number(process.env.VOXAI_MAX_PAYLOAD_BYTES || 4 * 1024 * 1024),
    maxConnections: Number(process.env.VOXAI_MAX_CONNECTIONS || (isProduction ? 200 : 40)),
    maxConnectionsPerIp: Number(process.env.VOXAI_MAX_CONNECTIONS_PER_IP || (isProduction ? 10 : 5)),
    maxMessagesPerMinute: Number(process.env.VOXAI_MAX_MESSAGES_PER_MINUTE || 1500),
    pingIntervalMs: Number(process.env.VOXAI_PING_INTERVAL_MS || 30000),
    startTimeoutMs: Number(process.env.VOXAI_START_TIMEOUT_MS || 15000),
    allowedOrigins: (process.env.VOXAI_ALLOWED_ORIGINS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
};

function log(level, message, fields = {}) {
    const payload = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...fields
    };
    const line = JSON.stringify(payload);
    if (level === 'error' || level === 'warn') {
        console.error(line);
    } else {
        console.log(line);
    }
}

function validateConfig() {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is required.');
    }

    const numericEntries = [
        ['PORT', CONFIG.port],
        ['VOXAI_MAX_PAYLOAD_BYTES', CONFIG.maxPayloadBytes],
        ['VOXAI_MAX_CONNECTIONS', CONFIG.maxConnections],
        ['VOXAI_MAX_CONNECTIONS_PER_IP', CONFIG.maxConnectionsPerIp],
        ['VOXAI_MAX_MESSAGES_PER_MINUTE', CONFIG.maxMessagesPerMinute],
        ['VOXAI_PING_INTERVAL_MS', CONFIG.pingIntervalMs],
        ['VOXAI_START_TIMEOUT_MS', CONFIG.startTimeoutMs]
    ];

    for (const [name, value] of numericEntries) {
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`${name} must be a positive number.`);
        }
    }

    if (isProduction && CONFIG.allowedOrigins.length === 0) {
        throw new Error('VOXAI_ALLOWED_ORIGINS must be set in production.');
    }
}

function normalizeError(error) {
    if (error instanceof Error) {
        return error;
    }
    if (typeof error === 'string') {
        return new Error(error);
    }
    return new Error('Unknown relay error');
}

function normalizeVoiceName(value) {
    if (typeof value === 'string' && VOICE_ALLOWLIST.has(value)) {
        return value;
    }
    return CONFIG.defaultVoice;
}

function normalizeConversationMode(value) {
    return value === 'push-to-talk' ? 'push-to-talk' : 'vad';
}

function normalizeInstruction(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.trim().slice(0, 4000);
}

function sendMessage(ws, type, payload = {}) {
    if (ws.readyState !== WebSocket.OPEN) {
        return;
    }
    ws.send(JSON.stringify({ type, payload }));
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

function isAllowedOrigin(req) {
    if (!isProduction) {
        return true;
    }

    const origin = req.headers.origin;
    if (!origin) {
        return false;
    }

    return CONFIG.allowedOrigins.includes(origin);
}

function withinConnectionLimit(totalConnections, connectionsByIp, clientIp) {
    if (totalConnections >= CONFIG.maxConnections) {
        return { allowed: false, reason: 'Server is at max websocket capacity.' };
    }

    const perIp = connectionsByIp.get(clientIp) || 0;
    if (perIp >= CONFIG.maxConnectionsPerIp) {
        return { allowed: false, reason: 'Too many websocket connections for this IP.' };
    }

    return { allowed: true, reason: '' };
}

function withinMessageLimit(state) {
    const now = Date.now();
    if (now - state.messageWindowStart >= 60_000) {
        state.messageWindowStart = now;
        state.messageCount = 0;
    }
    state.messageCount += 1;
    return state.messageCount <= CONFIG.maxMessagesPerMinute;
}

function forwardGeminiMessage(ws, message) {
    const serverContent = message?.serverContent;
    if (!serverContent) {
        return;
    }

    if (serverContent.interrupted) {
        sendMessage(ws, 'interrupted');
        return;
    }

    const parts = serverContent.modelTurn?.parts || [];
    for (const part of parts) {
        if (part?.inlineData?.data) {
            sendMessage(ws, 'audio', { data: part.inlineData.data });
        }

        if (typeof part?.text === 'string' && part.text.trim()) {
            sendMessage(ws, 'transcript', {
                speaker: 'ai',
                text: part.text
            });
        }
    }

    const inputTranscript = serverContent.inputTranscription?.text;
    if (typeof inputTranscript === 'string' && inputTranscript.trim()) {
        sendMessage(ws, 'transcript', {
            speaker: 'user',
            text: inputTranscript
        });
    }

    const outputTranscript = serverContent.outputTranscription?.text;
    if (typeof outputTranscript === 'string' && outputTranscript.trim()) {
        sendMessage(ws, 'transcript', {
            speaker: 'ai',
            text: outputTranscript
        });
    }
}

async function startGeminiSession(ws, state, payload = {}) {
    if (state.starting || state.session) {
        return;
    }
    state.starting = true;

    try {
        const systemInstruction = normalizeInstruction(payload.systemInstruction);
        const voiceName = normalizeVoiceName(payload.voiceName);
        const conversationMode = normalizeConversationMode(payload.conversationMode);
        const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        state.client = client;
        state.voiceName = voiceName;
        state.mode = conversationMode;

        state.session = await client.live.connect({
            model: CONFIG.model,
            config: {
                responseModalities: [Modality.AUDIO],
                systemInstruction,
                outputAudioTranscription: {},
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName
                        }
                    }
                }
            },
            callbacks: {
                onopen: () => {
                    state.connected = true;
                    sendMessage(ws, 'connected', {
                        mode: conversationMode,
                        voiceName
                    });
                },
                onmessage: (message) => {
                    forwardGeminiMessage(ws, message);
                },
                onerror: (error) => {
                    sendMessage(ws, 'error', {
                        message: normalizeError(error).message
                    });
                },
                onclose: (event) => {
                    state.connected = false;
                    state.session = null;
                    if (state.closed) {
                        return;
                    }

                    sendMessage(ws, 'disconnected', {
                        reason: event?.reason || 'Gemini session closed'
                    });

                    if (ws.readyState === WebSocket.OPEN) {
                        ws.close(1011, 'Gemini session closed');
                    }
                }
            }
        });
    } catch (error) {
        const normalized = normalizeError(error);
        log('error', 'Failed to start Gemini session', {
            connectionId: state.connectionId,
            error: normalized.message
        });
        sendMessage(ws, 'error', { message: normalized.message });
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'Failed to initialize relay');
        }
    } finally {
        state.starting = false;
    }
}

function stopGeminiSession(state) {
    if (!state.session) {
        return;
    }
    try {
        state.session.close();
    } catch {
        // Ignore close errors.
    }
    state.session = null;
    state.connected = false;
}

validateConfig();

const app = next({ dev, hostname: CONFIG.host, port: CONFIG.port });
const handle = app.getRequestHandler();
const relayWss = new WebSocketServer({
    noServer: true,
    maxPayload: CONFIG.maxPayloadBytes,
    perMessageDeflate: false
});

const activeConnections = new Set();
const connectionsByIp = new Map();
let isShuttingDown = false;
let server = null;

await app.prepare();
const upgradeHandler = app.getUpgradeHandler();

relayWss.on('connection', (ws, req) => {
    const connectionId = randomUUID();
    const clientIp = getClientIp(req);
    const currentForIp = connectionsByIp.get(clientIp) || 0;
    connectionsByIp.set(clientIp, currentForIp + 1);
    activeConnections.add(ws);

    const state = {
        connectionId,
        clientIp,
        closed: false,
        starting: false,
        connected: false,
        session: null,
        client: null,
        mode: 'vad',
        voiceName: CONFIG.defaultVoice,
        messageWindowStart: Date.now(),
        messageCount: 0,
        isAlive: true
    };

    log('info', 'Relay connection opened', {
        connectionId,
        clientIp,
        totalConnections: activeConnections.size
    });

    const heartbeatTimer = setInterval(() => {
        if (!state.isAlive) {
            ws.terminate();
            return;
        }
        state.isAlive = false;
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, CONFIG.pingIntervalMs);

    const startTimer = setTimeout(() => {
        if (!state.session && ws.readyState === WebSocket.OPEN) {
            sendMessage(ws, 'error', { message: 'Start message timeout.' });
            ws.close(1008, 'Start timeout');
        }
    }, CONFIG.startTimeoutMs);

    ws.on('pong', () => {
        state.isAlive = true;
    });

    ws.on('message', async (raw) => {
        if (!withinMessageLimit(state)) {
            sendMessage(ws, 'error', { message: 'Rate limit exceeded.' });
            ws.close(1008, 'Rate limit exceeded');
            return;
        }

        let message = null;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            sendMessage(ws, 'error', { message: 'Invalid JSON payload.' });
            return;
        }

        const type = message?.type;
        const payload = message?.payload || {};

        if (type === 'start') {
            clearTimeout(startTimer);
            await startGeminiSession(ws, state, payload);
            return;
        }

        if (!state.session || !state.connected) {
            sendMessage(ws, 'error', { message: 'Relay session is not active.' });
            return;
        }

        if (type === 'audio') {
            if (!payload?.data) {
                return;
            }
            try {
                state.session.sendRealtimeInput({
                    audio: {
                        data: payload.data,
                        mimeType: payload.mimeType || 'audio/pcm;rate=16000'
                    }
                });
            } catch (error) {
                sendMessage(ws, 'error', { message: normalizeError(error).message });
            }
            return;
        }

        if (type === 'text') {
            if (!payload?.text || typeof payload.text !== 'string') {
                return;
            }
            try {
                state.session.sendClientContent({
                    turns: [
                        {
                            role: 'user',
                            parts: [{ text: payload.text }]
                        }
                    ],
                    turnComplete: true
                });
            } catch (error) {
                sendMessage(ws, 'error', { message: normalizeError(error).message });
            }
            return;
        }

        if (type === 'stop') {
            ws.close(1000, 'Client requested stop');
        }
    });

    const closeConnection = () => {
        clearInterval(heartbeatTimer);
        clearTimeout(startTimer);
        state.closed = true;
        stopGeminiSession(state);
        activeConnections.delete(ws);
        const nextCount = Math.max((connectionsByIp.get(clientIp) || 1) - 1, 0);
        if (nextCount === 0) {
            connectionsByIp.delete(clientIp);
        } else {
            connectionsByIp.set(clientIp, nextCount);
        }
        log('info', 'Relay connection closed', {
            connectionId,
            clientIp,
            totalConnections: activeConnections.size
        });
    };

    ws.on('close', closeConnection);
    ws.on('error', closeConnection);
});

server = createServer((req, res) => {
    let pathname = '/';
    try {
        pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
        pathname = '/';
    }

    if (pathname === '/healthz') {
        const payload = {
            status: 'ok',
            uptimeSeconds: Math.round(process.uptime()),
            websocketConnections: activeConnections.size
        };
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return;
    }

    if (pathname === '/readyz') {
        const ready = !isShuttingDown && !!process.env.GEMINI_API_KEY;
        const payload = {
            status: ready ? 'ready' : 'not-ready',
            shuttingDown: isShuttingDown
        };
        res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return;
    }

    handle(req, res);
});

server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
        pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
        pathname = '/';
    }

    if (isShuttingDown) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
    }

    if (pathname === '/api/live') {
        const clientIp = getClientIp(req);
        const allowed = withinConnectionLimit(activeConnections.size, connectionsByIp, clientIp);
        if (!allowed.allowed) {
            socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
            socket.destroy();
            return;
        }

        if (!isAllowedOrigin(req)) {
            log('warn', 'Blocked websocket origin', {
                origin: req.headers.origin,
                host: req.headers.host,
                forwardedHost: req.headers['x-forwarded-host']
            });
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }

        relayWss.handleUpgrade(req, socket, head, (ws) => {
            relayWss.emit('connection', ws, req);
        });
        return;
    }

    upgradeHandler(req, socket, head);
});

function gracefulShutdown(signal) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    log('info', `Received ${signal}. Starting graceful shutdown.`);

    for (const ws of activeConnections) {
        try {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(1012, 'Server restarting');
            }
        } catch {
            // Ignore close errors.
        }
    }

    relayWss.close();
    server.close((error) => {
        if (error) {
            log('error', 'Error during shutdown', { error: normalizeError(error).message });
            process.exit(1);
            return;
        }
        log('info', 'Shutdown complete');
        process.exit(0);
    });

    setTimeout(() => {
        log('warn', 'Forced shutdown after timeout');
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.listen(CONFIG.port, CONFIG.host, () => {
    log('info', 'VoxAI server started', {
        host: CONFIG.host,
        port: CONFIG.port,
        mode: dev ? 'development' : 'production',
        maxConnections: CONFIG.maxConnections
    });
});
