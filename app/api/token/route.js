/**
 * API Route: token endpoint for Gemini Live auth.
 * This still returns an API key to the browser; for stronger production security,
 * move realtime API interaction to a trusted server environment.
 */

import { NextResponse } from 'next/server';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 40;
const requestLog = new Map();

const NO_STORE_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
};

export const dynamic = 'force-dynamic';

function json(data, init = {}) {
    return NextResponse.json(data, {
        ...init,
        headers: {
            ...NO_STORE_HEADERS,
            ...(init.headers || {})
        }
    });
}

function getClientIp(request) {
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) {
        return forwardedFor.split(',')[0].trim();
    }
    return request.headers.get('x-real-ip') || 'unknown';
}

function isSameOrigin(request) {
    const host = request.headers.get('host');
    if (!host) {
        return false;
    }

    const protocol = request.nextUrl.protocol;
    const expectedOrigin = `${protocol}//${host}`;
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');

    if (origin) {
        return origin === expectedOrigin;
    }
    if (referer) {
        return referer.startsWith(expectedOrigin);
    }
    return true;
}

function isRateLimited(clientIp) {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const entries = requestLog.get(clientIp) || [];
    const recentEntries = entries.filter(timestamp => timestamp >= windowStart);

    if (recentEntries.length >= RATE_LIMIT_MAX_REQUESTS) {
        requestLog.set(clientIp, recentEntries);
        return true;
    }

    recentEntries.push(now);
    requestLog.set(clientIp, recentEntries);
    return false;
}

export async function GET(request) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return json({ error: 'API key not configured on server' }, { status: 500 });
        }

        if (!isSameOrigin(request)) {
            return json({ error: 'Forbidden origin' }, { status: 403 });
        }

        const clientHint = request.headers.get('x-vox-client');
        if (clientHint !== '1') {
            return json({ error: 'Missing client header' }, { status: 400 });
        }

        const clientIp = getClientIp(request);
        if (isRateLimited(clientIp)) {
            return json({ error: 'Too many requests. Please retry shortly.' }, { status: 429 });
        }

        return json({ apiKey });
    } catch (error) {
        console.error('Failed to get API key:', error);
        return json({ error: 'Failed to get API key' }, { status: 500 });
    }
}

export async function POST() {
    return json({ error: 'Method not allowed' }, { status: 405 });
}
