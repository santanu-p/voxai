import '@/styles/globals.css';

export const metadata = {
    title: 'VoxAI - Talk to Véra',
    description: 'Experience the future of voice AI. Have natural conversations with Véra, your intelligent voice assistant.',
    icons: {
        icon: '/favicon.svg',
    },
};

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <head>
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
                <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
            </head>
            <body>{children}</body>
        </html>
    );
}
