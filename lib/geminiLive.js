/**
 * Gemini Live API Module
 * Handles WebSocket connection to Gemini for real-time audio conversation
 * Fetches API key securely from server
 */

import { GoogleGenAI, Modality } from '@google/genai';

export class GeminiLive {
    constructor(options = {}) {
        this.model = options.model || 'gemini-2.5-flash-native-audio-preview-12-2025';
        this.systemInstruction = options.systemInstruction ||
            'You are a helpful, friendly, and knowledgeable AI assistant. Respond naturally and conversationally, as if having a real-time voice conversation. Be concise but thorough in your responses.';

        this.onConnected = options.onConnected || (() => { });
        this.onDisconnected = options.onDisconnected || (() => { });
        this.onAudioResponse = options.onAudioResponse || (() => { });
        this.onInterrupted = options.onInterrupted || (() => { });
        this.onError = options.onError || console.error;
        this.onTranscript = options.onTranscript || (() => { });

        this.client = null;
        this.session = null;
        this.isConnected = false;
    }

    setSystemInstruction(instruction) {
        this.systemInstruction = instruction;
    }

    /**
     * Fetch API key from secure server endpoint
     */
    async getApiKey() {
        try {
            const response = await fetch('/api/token');

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to get API key');
            }

            const data = await response.json();
            return data.apiKey;
        } catch (error) {
            console.error('Failed to fetch API key:', error);
            throw error;
        }
    }

    async connect() {
        try {
            // Get API key from server (keeps it out of client bundle)
            const apiKey = await this.getApiKey();

            // Initialize client
            this.client = new GoogleGenAI({ apiKey });

            const config = {
                responseModalities: [Modality.AUDIO],
                systemInstruction: this.systemInstruction,
                outputAudioTranscription: {},
                // Enable Voice Activity Detection for natural interruptions
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: 'Aoede'
                        }
                    }
                }
            };

            this.session = await this.client.live.connect({
                model: this.model,
                config: config,
                callbacks: {
                    onopen: () => {
                        console.log('Connected to Gemini Live API');
                        this.isConnected = true;
                        this.onConnected();
                    },
                    onmessage: (message) => {
                        this.handleMessage(message);
                    },
                    onerror: (error) => {
                        console.error('Gemini Live API error:', error);
                        this.onError(error);
                    },
                    onclose: (event) => {
                        console.log('Disconnected from Gemini Live API:', event?.reason || 'Unknown reason');
                        this.isConnected = false;
                        this.onDisconnected(event);
                    }
                }
            });

            return true;
        } catch (error) {
            console.error('Failed to connect:', error);
            this.onError(error);
            return false;
        }
    }

    handleMessage(message) {
        if (message.serverContent && message.serverContent.interrupted) {
            console.log('Response interrupted');
            this.onInterrupted();
            return;
        }

        if (message.serverContent &&
            message.serverContent.modelTurn &&
            message.serverContent.modelTurn.parts) {

            for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData && part.inlineData.data) {
                    this.onAudioResponse(part.inlineData.data);
                }

                if (part.text) {
                    this.onTranscript(part.text, 'ai');
                }
            }
        }

        if (message.serverContent && message.serverContent.inputTranscription) {
            this.onTranscript(message.serverContent.inputTranscription.text, 'user');
        }

        if (message.serverContent && message.serverContent.outputTranscription) {
            this.onTranscript(message.serverContent.outputTranscription.text, 'ai');
        }
    }

    sendAudio(base64Audio) {
        if (!this.session || !this.isConnected) return;

        try {
            this.session.sendRealtimeInput({
                audio: {
                    data: base64Audio,
                    mimeType: 'audio/pcm;rate=16000'
                }
            });
        } catch (error) {
            console.error('Failed to send audio:', error);
        }
    }

    sendText(text) {
        if (!this.session || !this.isConnected) return;

        try {
            this.session.sendClientContent({
                turns: text,
                turnComplete: true
            });
        } catch (error) {
            console.error('Failed to send text:', error);
        }
    }

    disconnect() {
        if (this.session) {
            try {
                this.session.close();
            } catch (error) {
                console.error('Error closing session:', error);
            }
            this.session = null;
        }

        this.isConnected = false;
        this.onDisconnected({ reason: 'User disconnected' });
    }

    isActive() {
        return this.isConnected && this.session !== null;
    }
}
