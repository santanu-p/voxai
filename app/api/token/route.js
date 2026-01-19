/**
 * API Route: Secure API Key Proxy
 * Provides the API key from server-side environment
 * In production, you should add additional security measures like:
 * - Rate limiting
 * - Session validation
 * - CORS restrictions
 */

export async function GET(request) {
    try {
        // Get API key from server-side environment (not exposed in client bundle)
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return Response.json(
                { error: 'API key not configured on server' },
                { status: 500 }
            );
        }

        // Return the API key for this session
        // In production, consider adding:
        // - Session tokens
        // - Rate limiting
        // - Request origin validation
        return Response.json({ apiKey });

    } catch (error) {
        console.error('Failed to get API key:', error);
        return Response.json(
            { error: 'Failed to get API key' },
            { status: 500 }
        );
    }
}

// Block other methods
export async function POST() {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
}
