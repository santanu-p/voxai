/**
 * Gemini Live Relay Client (Browser)
 * Connects to a server-side WebSocket relay so API keys never reach the client.
 */

function normalizeError(error) {
    if (error instanceof Error) {
        return error;
    }
    if (typeof error === 'string') {
        return new Error(error);
    }
    return new Error('Unknown relay error');
}

export class GeminiLive {
    constructor(options = {}) {
        this.model = options.model || 'gemini-2.5-flash-native-audio-preview-12-2025';
        this.systemInstruction = options.systemInstruction ||
            'You are a helpful, friendly, and knowledgeable AI assistant. Respond naturally and conversationally with concise but complete answers.';
        this.voiceName = options.voiceName || 'Aoede';
        this.conversationMode = options.conversationMode || 'vad';
        this.relayPath = options.relayPath || '/api/live';
        this.connectionTimeoutMs = options.connectionTimeoutMs || 12000;

        this.onConnected = options.onConnected || (() => { });
        this.onDisconnected = options.onDisconnected || (() => { });
        this.onAudioResponse = options.onAudioResponse || (() => { });
        this.onInterrupted = options.onInterrupted || (() => { });
        this.onError = options.onError || (() => { });
        this.onTranscript = options.onTranscript || (() => { });

        this.socket = null;
        this.isConnected = false;
        this.disconnectNotified = false;
        this.isDisconnecting = false;
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

    buildRelayUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}${this.relayPath}`;
    }

    sendJson(payload) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return false;
        }

        this.socket.send(JSON.stringify(payload));
        return true;
    }

    notifyDisconnected(event) {
        if (this.disconnectNotified) {
            return;
        }
        this.disconnectNotified = true;
        this.onDisconnected(event);
    }

    async connect() {
        if (this.isConnected && this.socket?.readyState === WebSocket.OPEN) {
            return true;
        }

        this.isDisconnecting = false;
        this.disconnectNotified = false;

        const url = this.buildRelayUrl();
        let settled = false;

        return new Promise((resolve) => {
            let timeoutId = null;

            const finalize = (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
                resolve(value);
            };

            try {
                this.socket = new WebSocket(url);
            } catch (error) {
                this.onError(normalizeError(error));
                finalize(false);
                return;
            }

            timeoutId = setTimeout(() => {
                if (!this.isConnected) {
                    this.onError(new Error('Connection timed out'));
                    this.disconnect();
                    finalize(false);
                }
            }, this.connectionTimeoutMs);

            this.socket.onopen = () => {
                const sent = this.sendJson({
                    type: 'start',
                    payload: {
                        model: this.model,
                        systemInstruction: this.systemInstruction,
                        voiceName: this.voiceName,
                        conversationMode: this.conversationMode
                    }
                });

                if (!sent) {
                    this.onError(new Error('Failed to initialize relay session'));
                    finalize(false);
                }
            };

            this.socket.onmessage = (event) => {
                let message = null;
                try {
                    message = JSON.parse(event.data);
                } catch {
                    return;
                }

                this.handleMessage(message);
                if (message?.type === 'connected') {
                    this.isConnected = true;
                    this.disconnectNotified = false;
                    this.onConnected();
                    finalize(true);
                }
            };

            this.socket.onerror = (event) => {
                if (!this.isConnected) {
                    finalize(false);
                }
                this.onError(
                    normalizeError(
                        event?.error ||
                        'WebSocket connection error. Ensure the app runs via `npm run dev` (custom relay server).'
                    )
                );
            };

            this.socket.onclose = (event) => {
                this.isConnected = false;
                this.socket = null;
                if (!settled) {
                    const reason = event?.reason ? String(event.reason) : '';
                    if (!this.isConnected && (event?.code === 1006 || event?.code === 1011)) {
                        this.onError(
                            new Error(
                                reason ||
                                'Relay disconnected before session start. Check server logs and websocket origin settings.'
                            )
                        );
                    }
                    finalize(false);
                }
                this.notifyDisconnected(event);
            };
        });
    }

    handleMessage(message) {
        switch (message?.type) {
            case 'audio':
                if (message.payload?.data) {
                    this.onAudioResponse(message.payload.data);
                }
                break;
            case 'interrupted':
                this.onInterrupted();
                break;
            case 'transcript':
                if (message.payload?.text) {
                    this.onTranscript(message.payload.text, message.payload.speaker || 'ai');
                }
                break;
            case 'error':
                this.onError(new Error(message.payload?.message || 'Relay error'));
                break;
            default:
                break;
        }
    }

    sendAudio(base64Audio) {
        if (!base64Audio || !this.isConnected) {
            return;
        }

        const sent = this.sendJson({
            type: 'audio',
            payload: {
                data: base64Audio,
                mimeType: 'audio/pcm;rate=16000'
            }
        });

        if (!sent) {
            this.onError(new Error('Failed to stream audio to relay'));
        }
    }

    sendText(text) {
        if (!text?.trim() || !this.isConnected) {
            return;
        }

        const sent = this.sendJson({
            type: 'text',
            payload: {
                text: text.trim()
            }
        });

        if (!sent) {
            this.onError(new Error('Failed to send text to relay'));
        }
    }

    disconnect() {
        if (this.isDisconnecting) {
            return;
        }

        this.isDisconnecting = true;

        if (this.socket) {
            try {
                this.sendJson({ type: 'stop' });
                this.socket.close(1000, 'User disconnected');
            } catch (error) {
                this.onError(normalizeError(error));
            }
        }

        this.socket = null;
        this.isConnected = false;
        this.notifyDisconnected({ reason: 'User disconnected' });
    }

    isActive() {
        return this.isConnected && this.socket?.readyState === WebSocket.OPEN;
    }
}
