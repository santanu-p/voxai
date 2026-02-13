/**
 * Gemini Live API Client (Browser)
 * Uses short-lived auth tokens from /api/token so long-lived API keys stay server-side.
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
            'You are a helpful, friendly, and knowledgeable AI assistant. Respond naturally and conversationally with concise but complete answers.';
        this.voiceName = options.voiceName || 'Aoede';
        this.conversationMode = options.conversationMode || 'vad';
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
        this.tokenAbortController = null;
    }

    setSystemInstruction(instruction) {
        if (typeof instruction === 'string' && instruction.trim()) {
            this.systemInstruction = instruction.trim();
        }
    }

    setVoiceName(voiceName) {
        if (typeof voiceName === 'string' && voiceName.trim()) {
            this.voiceName = voiceName.trim();
        }
    }

    setConversationMode(mode) {
        this.conversationMode = mode === 'push-to-talk' ? 'push-to-talk' : 'vad';
    }

    notifyDisconnected(event) {
        if (this.disconnectNotified) {
            return;
        }
        this.disconnectNotified = true;
        this.onDisconnected(event);
    }

    async getEphemeralToken() {
        this.tokenAbortController = new AbortController();
        const timeoutId = setTimeout(() => {
            this.tokenAbortController?.abort();
        }, this.connectionTimeoutMs);

        try {
            const response = await fetch(this.tokenEndpoint, {
                method: 'POST',
                cache: 'no-store',
                credentials: 'same-origin',
                headers: {
                    'content-type': 'application/json',
                    Accept: 'application/json',
                    'x-vox-client': '1'
                },
                body: JSON.stringify({
                    model: this.model,
                    systemInstruction: this.systemInstruction,
                    voiceName: this.voiceName,
                    conversationMode: this.conversationMode
                }),
                signal: this.tokenAbortController.signal
            });

            let payload = null;
            try {
                payload = await response.json();
            } catch {
                payload = null;
            }

            if (!response.ok) {
                throw new Error(payload?.error || 'Failed to create Gemini session token');
            }

            if (!payload?.token) {
                throw new Error('Token endpoint returned an empty token');
            }

            return payload.token;
        } finally {
            clearTimeout(timeoutId);
            this.tokenAbortController = null;
        }
    }

    async connect() {
        if (this.isConnected && this.session) {
            return true;
        }

        this.disconnectNotified = false;
        this.isDisconnecting = false;

        try {
            const token = await this.getEphemeralToken();
            this.client = new GoogleGenAI({
                apiKey: token,
                httpOptions: { apiVersion: 'v1alpha' }
            });

            this.session = await this.client.live.connect({
                model: this.model,
                config: {
                    responseModalities: [Modality.AUDIO],
                    systemInstruction: this.systemInstruction,
                    outputAudioTranscription: {},
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: this.voiceName
                            }
                        }
                    }
                },
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
        if (!base64Audio || !this.session || !this.isConnected) {
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
        if (!text?.trim() || !this.session || !this.isConnected) {
            return;
        }

        try {
            this.session.sendClientContent({
                turns: [
                    {
                        role: 'user',
                        parts: [{ text: text.trim() }]
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
        this.tokenAbortController?.abort();

        if (this.session) {
            try {
                this.session.close();
            } catch (error) {
                this.onError(normalizeError(error));
            }
        }

        this.session = null;
        this.client = null;
        this.isConnected = false;
        this.notifyDisconnected({ reason: 'User disconnected' });
    }

    isActive() {
        return this.isConnected && this.session !== null;
    }
}
