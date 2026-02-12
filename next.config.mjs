/** @type {import('next').NextConfig} */
const securityHeaders = [
    {
        key: 'X-Frame-Options',
        value: 'DENY',
    },
    {
        key: 'X-Content-Type-Options',
        value: 'nosniff',
    },
    {
        key: 'Referrer-Policy',
        value: 'strict-origin-when-cross-origin',
    },
    {
        key: 'Permissions-Policy',
        value: 'microphone=(self), camera=()',
    },
    {
        key: 'Cross-Origin-Opener-Policy',
        value: 'same-origin',
    },
    {
        key: 'Cross-Origin-Resource-Policy',
        value: 'same-site',
    },
    {
        key: 'Strict-Transport-Security',
        value: 'max-age=31536000; includeSubDomains; preload',
    },
];

const nextConfig = {
    reactStrictMode: true,
    devIndicators: false,
    poweredByHeader: false,
    async headers() {
        return [
            {
                source: '/(.*)',
                headers: securityHeaders,
            },
        ];
    },
};

export default nextConfig;
