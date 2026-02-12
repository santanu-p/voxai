import '@/styles/globals.css';
import { Inter, Space_Grotesk } from 'next/font/google';

const inter = Inter({
    subsets: ['latin'],
    weight: ['300', '400', '500', '600'],
    display: 'swap',
    variable: '--font-inter'
});

const spaceGrotesk = Space_Grotesk({
    subsets: ['latin'],
    weight: ['300', '400', '500', '600', '700'],
    display: 'swap',
    variable: '--font-space-grotesk'
});

export const metadata = {
    title: 'VoxAI - Talk to Vera',
    description: 'Experience natural voice conversations with Vera, your intelligent voice assistant.',
    icons: {
        icon: '/favicon.svg',
    },
};

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <body className={`${inter.variable} ${spaceGrotesk.variable}`}>{children}</body>
        </html>
    );
}
