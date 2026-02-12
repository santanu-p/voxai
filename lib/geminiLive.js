/**
 * Gemini Live API Module
 * Handles realtime audio connection and message parsing.
 */

import { GoogleGenAI, Modality } from '@google/genai';

function normalizeError(error) {
    if (error instanceof Error) {
        return error;
    }
    if (typeof error === 'string') {
        return new Error(error);
    }
    return new Error('Unknown Gemini Live error');
}

export class GeminiLive {
    constructor(options = {}) {
        this.model = options.model || 'gemini-2.5-flash-native-audio-preview-12-2025';
        this.systemInstruction = options.systemInstruction ||
            'You are a helpful, friendly, and knowledgeable AI assistant. Respond naturally and conversationally, as if having a realtime voice conversation. Be concise but thorough.';
        this.tokenEndpoint = options.tokenEndpoint || '/api/token';
        this.connectionTimeoutMs = options.connectionTimeoutMs || 12000;

        this.onConnected = options.onConnected || (() => { });
        this.onDisconnected = options.onDisconnected || (() => { });
        this.onAudioResponse = options.onAudioResponse || (() => { });
        this.onInterrupted = options.onInterrupted || (() => { });
        this.onError = options.onError || (() => { });
        this.onTranscript = options.onTranscript || (() => { });

        this.client = null;
        this.session = null;
        this.isConnected = false;
        this.disconnectNotified = false;
        this.isDisconnecting = false;
        this.apiKeyAbortController = null;
    }

    setSystemInstruction(instruction) {
        if (typeof instruction === 'string' && instruction.trim()) {
            this.systemInstruction = instruction.trim();
        }
    }

    notifyDisconnected(event) {
        if (this.disconnectNotified) {
            return;
        }
        this.disconnectNotified = true;
        this.onDisconnected(event);
    }

    async getApiKey() {
        this.apiKeyAbortController = new AbortController();
        const timeout = setTimeout(() => {
            this.apiKeyAbortController?.abort();
        }, this.connectionTimeoutMs);

        try {
            const response = await fetch(this.tokenEndpoint, {
                method: 'GET',
                cache: 'no-store',
                credentials: 'same-origin',
                headers: {
                    Accept: 'application/json',
                    'x-vox-client': '1'
                },
                signal: this.apiKeyAbortController.signal
            });

            if (!response.ok) {
                let errorPayload = null;
                try {
                    errorPayload = await response.json();
                } catch {
                    errorPayload = null;
                }
                throw new Error(errorPayload?.error || 'Failed to get API key');
            }

            const data = await response.json();
            if (!data?.apiKey) {
                throw new Error('API key missing in server response');
            }

            return data.apiKey;
        } finally {
            clearTimeout(timeout);
            this.apiKeyAbortController = null;
        }
    }

    async connect() {
        if (this.isConnected && this.session) {
            return true;
        }

        this.disconnectNotified = false;
        this.isDisconnecting = false;

        try {
            const apiKey = await this.getApiKey();
            this.client = new GoogleGenAI({ apiKey });

            const config = {
                responseModalities: [Modality.AUDIO],
                systemInstruction: this.systemInstruction,
                outputAudioTranscription: {},
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
                config,
                callbacks: {
                    onopen: () => {
                        this.isConnected = true;
                        this.disconnectNotified = false;
                        this.onConnected();
                    },
                    onmessage: (message) => {
                        this.handleMessage(message);
                    },
                    onerror: (error) => {
                        this.onError(normalizeError(error));
                    },
                    onclose: (event) => {
                        this.isConnected = false;
                        this.session = null;
                        this.notifyDisconnected(event);
                    }
                }
            });

            return true;
        } catch (error) {
            this.isConnected = false;
            this.session = null;
            this.onError(normalizeError(error));
            return false;
        }
    }

    handleMessage(message) {
        const serverContent = message?.serverContent;
        if (!serverContent) {
            return;
        }

        if (serverContent.interrupted) {
            this.onInterrupted();
            return;
        }

        const parts = serverContent.modelTurn?.parts || [];
        for (const part of parts) {
            if (part?.inlineData?.data) {
                this.onAudioResponse(part.inlineData.data);
            }

            if (typeof part?.text === 'string' && part.text.trim()) {
                this.onTranscript(part.text, 'ai');
            }
        }

        const inputTranscript = serverContent.inputTranscription?.text;
        if (typeof inputTranscript === 'string' && inputTranscript.trim()) {
            this.onTranscript(inputTranscript, 'user');
        }

        const outputTranscript = serverContent.outputTranscription?.text;
        if (typeof outputTranscript === 'string' && outputTranscript.trim()) {
            this.onTranscript(outputTranscript, 'ai');
        }
    }

    sendAudio(base64Audio) {
        if (!this.session || !this.isConnected || !base64Audio) {
            return;
        }

        try {
            this.session.sendRealtimeInput({
                audio: {
                    data: base64Audio,
                    mimeType: 'audio/pcm;rate=16000'
                }
            });
        } catch (error) {
            this.onError(normalizeError(error));
        }
    }

    sendText(text) {
        if (!this.session || !this.isConnected || !text?.trim()) {
            return;
        }

        try {
            this.session.sendClientContent({
                turns: [
                    {
                        role: 'user',
                        parts: [{ text }]
                    }
                ],
                turnComplete: true
            });
        } catch (error) {
            this.onError(normalizeError(error));
        }
    }

    disconnect() {
        if (this.isDisconnecting) {
            return;
        }

        this.isDisconnecting = true;
        this.apiKeyAbortController?.abort();

        if (this.session) {
            try {
                this.session.close();
            } catch (error) {
                this.onError(normalizeError(error));
            }
        }

        this.session = null;
        this.isConnected = false;
        this.notifyDisconnected({ reason: 'User disconnected' });
    }

    isActive() {
        return this.isConnected && this.session !== null;
    }
}
