import { createServer } from 'node:http';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_VOICE_NAME = 'Aoede';
const DEFAULT_MODE = 'vad';
const VOICE_ALLOWLIST = new Set(['Aoede', 'Kore', 'Leda', 'Puck', 'Zephyr']);

function sendMessage(ws, type, payload = {}) {
    if (ws.readyState !== WebSocket.OPEN) {
        return;
    }

    ws.send(JSON.stringify({ type, payload }));
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
    return DEFAULT_VOICE_NAME;
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

function isAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) {
        return true;
    }

    const host = req.headers.host;
    if (!host) {
        return false;
    }

    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = typeof forwardedProto === 'string'
        ? forwardedProto.split(',')[0].trim()
        : 'http';
    const expected = `${protocol}://${host}`;

    if (origin === expected) {
        return true;
    }

    const extraAllowList = (process.env.VOXAI_ALLOWED_ORIGINS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

    return extraAllowList.includes(origin);
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
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY is not configured on the server.');
        }

        const systemInstruction = normalizeInstruction(payload.systemInstruction);
        const voiceName = normalizeVoiceName(payload.voiceName);
        const conversationMode = normalizeConversationMode(payload.conversationMode);

        const client = new GoogleGenAI({ apiKey });
        state.client = client;
        state.mode = conversationMode;
        state.voiceName = voiceName;

        state.session = await client.live.connect({
            model: MODEL_NAME,
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
                        reason: event?.reason || 'Upstream closed'
                    });

                    if (ws.readyState === WebSocket.OPEN) {
                        ws.close(1011, 'Gemini session closed');
                    }
                }
            }
        });
    } catch (error) {
        sendMessage(ws, 'error', {
            message: normalizeError(error).message
        });

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

const dev = process.argv.includes('--dev');
process.env.NODE_ENV = dev ? 'development' : 'production';

const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname: '0.0.0.0', port });
const handle = app.getRequestHandler();
const relayWss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024
});

await app.prepare();
const upgradeHandler = app.getUpgradeHandler();

relayWss.on('connection', (ws) => {
    const state = {
        client: null,
        session: null,
        connected: false,
        starting: false,
        closed: false,
        mode: DEFAULT_MODE,
        voiceName: DEFAULT_VOICE_NAME
    };

    const pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000);

    ws.on('message', async (raw) => {
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

    ws.on('close', () => {
        clearInterval(pingTimer);
        state.closed = true;
        stopGeminiSession(state);
    });

    ws.on('error', () => {
        clearInterval(pingTimer);
        state.closed = true;
        stopGeminiSession(state);
    });
});

const server = createServer((req, res) => {
    handle(req, res);
});

server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        pathname = parsed.pathname;
    } catch {
        pathname = '/';
    }

    if (pathname === '/api/live') {
        if (!isAllowedOrigin(req)) {
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

server.listen(port, () => {
    console.log(`VoxAI server running on http://localhost:${port} (dev=${dev})`);
});
