import { NextResponse } from 'next/server';
import { GoogleGenAI, Modality } from '@google/genai';

const NO_STORE_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
};
const VOICE_ALLOWLIST = new Set(['Aoede', 'Kore', 'Leda', 'Puck', 'Zephyr']);
const DEFAULT_MODEL = process.env.NOA_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_VOICE = process.env.NOA_DEFAULT_VOICE || 'Aoede';
const DEFAULT_SYSTEM_INSTRUCTION =
    'You are Noa, a warm, intelligent, and helpful AI voice assistant. You speak naturally and conversationally with a friendly and professional tone. Be concise but thorough in your responses.';
const RATE_LIMIT_WINDOW_MS = parsePositiveInteger(process.env.NOA_TOKEN_RATE_WINDOW_MS, 60_000);
const RATE_LIMIT_PER_IP = parsePositiveInteger(process.env.NOA_TOKEN_RATE_LIMIT_PER_IP, 12);
const RATE_LIMIT_GLOBAL = parsePositiveInteger(process.env.NOA_TOKEN_RATE_LIMIT_GLOBAL, 300);
const MAX_INFLIGHT = parsePositiveInteger(process.env.NOA_TOKEN_MAX_INFLIGHT, 120);
const ALLOWED_ORIGINS = new Set(
    (process.env.NOA_ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => normalizeOrigin(origin.trim()))
        .filter(Boolean)
);
const REQUEST_COUNTS_BY_IP = new Map();
let globalWindowStartedAt = Date.now();
let globalWindowCount = 0;
let inFlightTokenRequests = 0;
let cachedClient = null;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function json(data, init = {}) {
    return NextResponse.json(data, {
        ...init,
        headers: {
            ...NO_STORE_HEADERS,
            ...(init.headers || {})
        }
    });
}

function normalizeVoiceName(value) {
    if (typeof value === 'string' && VOICE_ALLOWLIST.has(value)) {
        return value;
    }
    return DEFAULT_VOICE;
}

function normalizeInstruction(value) {
    if (typeof value !== 'string') {
        return DEFAULT_SYSTEM_INSTRUCTION;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 4000) : DEFAULT_SYSTEM_INSTRUCTION;
}

function normalizeOrigin(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return '';
    }

    try {
        return new URL(value).origin;
    } catch {
        return '';
    }
}

function getClientIp(request) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (typeof forwarded === 'string' && forwarded.trim()) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) {
            return first;
        }
    }
    const realIp = request.headers.get('x-real-ip');
    if (typeof realIp === 'string' && realIp.trim()) {
        return realIp.trim();
    }
    return 'unknown';
}

function getRateLimitState(clientIp) {
    const now = Date.now();

    if (now - globalWindowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        globalWindowStartedAt = now;
        globalWindowCount = 0;
        REQUEST_COUNTS_BY_IP.clear();
    }

    const ipCount = REQUEST_COUNTS_BY_IP.get(clientIp) || 0;
    const retryAfterSeconds = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - globalWindowStartedAt)) / 1000));

    if (ipCount >= RATE_LIMIT_PER_IP) {
        return { allowed: false, retryAfterSeconds, reason: 'Too many token requests from this IP. Please retry shortly.' };
    }

    if (globalWindowCount >= RATE_LIMIT_GLOBAL) {
        return { allowed: false, retryAfterSeconds, reason: 'Server is busy issuing tokens. Please retry shortly.' };
    }

    REQUEST_COUNTS_BY_IP.set(clientIp, ipCount + 1);
    globalWindowCount += 1;
    return { allowed: true, retryAfterSeconds: 0, reason: '' };
}

function getGoogleClient() {
    if (cachedClient) {
        return cachedClient;
    }

    cachedClient = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: { apiVersion: 'v1alpha' }
    });

    return cachedClient;
}

function isOriginAllowed(request) {
    if (process.env.NODE_ENV !== 'production') {
        return true;
    }

    if (ALLOWED_ORIGINS.size === 0) {
        return false;
    }

    const requestOrigin = normalizeOrigin(request.headers.get('origin') || '');
    if (!requestOrigin) {
        return false;
    }

    return ALLOWED_ORIGINS.has(requestOrigin);
}

export async function GET() {
    return json({ error: 'Method not allowed' }, { status: 405 });
}

export async function POST(request) {
    if (!process.env.GEMINI_API_KEY) {
        return json({ error: 'GEMINI_API_KEY is not configured' }, { status: 500 });
    }

    if (!isOriginAllowed(request)) {
        return json({ error: 'Origin not allowed' }, { status: 403 });
    }

    const clientIp = getClientIp(request);
    const rateLimit = getRateLimitState(clientIp);
    if (!rateLimit.allowed) {
        return json(
            { error: rateLimit.reason },
            {
                status: 429,
                headers: {
                    'Retry-After': String(rateLimit.retryAfterSeconds)
                }
            }
        );
    }

    if (inFlightTokenRequests >= MAX_INFLIGHT) {
        return json(
            { error: 'Server is currently busy. Please retry in a few seconds.' },
            {
                status: 503,
                headers: {
                    'Retry-After': '2'
                }
            }
        );
    }

    let body = {};
    try {
        body = await request.json();
    } catch {
        body = {};
    }

    const model = typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : DEFAULT_MODEL;
    const voiceName = normalizeVoiceName(body.voiceName);
    const systemInstruction = normalizeInstruction(body.systemInstruction);

    try {
        inFlightTokenRequests += 1;
        const client = getGoogleClient();

        const now = Date.now();
        const token = await client.authTokens.create({
            config: {
                uses: 1,
                newSessionExpireTime: new Date(now + 60_000).toISOString(),
                expireTime: new Date(now + 30 * 60_000).toISOString(),
                liveConnectConstraints: {
                    model,
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
                    }
                }
            }
        });

        if (!token?.name) {
            throw new Error('The AI provider did not return a token');
        }

        return json({
            token: token.name,
            model,
            voiceName
        });
    } catch (error) {
        return json(
            {
                error: error instanceof Error ? error.message : 'Failed to create auth token'
            },
            { status: 500 }
        );
    } finally {
        inFlightTokenRequests = Math.max(0, inFlightTokenRequests - 1);
    }
}
