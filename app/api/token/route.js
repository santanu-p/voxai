import { NextResponse } from 'next/server';

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

export async function GET() {
    return json(
        {
            error: 'Deprecated endpoint. Use /api/live websocket relay.',
        },
        { status: 410 }
    );
}

export async function POST() {
    return json({ error: 'Method not allowed' }, { status: 405 });
}
