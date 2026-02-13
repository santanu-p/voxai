import { NextResponse } from 'next/server';
import { GoogleGenAI, Modality } from '@google/genai';

const NO_STORE_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
};
const VOICE_ALLOWLIST = new Set(['Aoede', 'Kore', 'Leda', 'Puck', 'Zephyr']);
const DEFAULT_MODEL = process.env.VOXAI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_VOICE = process.env.VOXAI_DEFAULT_VOICE || 'Aoede';
const DEFAULT_SYSTEM_INSTRUCTION =
    'You are Vera, a warm, intelligent, and helpful AI voice assistant. You speak naturally and conversationally with a friendly and professional tone. Be concise but thorough in your responses.';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

function getAllowedOrigins() {
    return new Set(
        (process.env.VOXAI_ALLOWED_ORIGINS || '')
            .split(',')
            .map((origin) => normalizeOrigin(origin.trim()))
            .filter(Boolean)
    );
}

function isOriginAllowed(request) {
    if (process.env.NODE_ENV !== 'production') {
        return true;
    }

    const allowedOrigins = getAllowedOrigins();
    if (allowedOrigins.size === 0) {
        return false;
    }

    const requestOrigin = normalizeOrigin(request.headers.get('origin') || '');
    if (!requestOrigin) {
        return false;
    }

    return allowedOrigins.has(requestOrigin);
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
        const client = new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY,
            httpOptions: { apiVersion: 'v1alpha' }
        });

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
            throw new Error('Gemini did not return a token');
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
    }
}
