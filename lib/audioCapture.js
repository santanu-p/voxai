/**
 * Audio Capture Module
 * Handles microphone access and PCM audio encoding for Gemini Live API.
 */

export class AudioCapture {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 16000;
        this.onAudioData = options.onAudioData || (() => { });
        this.onError = options.onError || (() => { });
        this.onStateChange = options.onStateChange || (() => { });

        this.audioContext = null;
        this.mediaStream = null;
        this.sourceNode = null;
        this.processorNode = null;
        this.isCapturing = false;
        this.isMuted = false;

        this.analyzerNode = null;
        this.analyzerData = null;
    }

    async start() {
        if (this.isCapturing) {
            return true;
        }

        try {
            if (!navigator?.mediaDevices?.getUserMedia) {
                throw new Error('Audio capture is not supported in this browser.');
            }

            this.mediaStream = await this.getMicrophoneStream();

            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextCtor) {
                throw new Error('Web Audio API is not supported in this browser.');
            }

            this.audioContext = new AudioContextCtor({
                sampleRate: this.sampleRate
            });

            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
            this.analyzerNode = this.audioContext.createAnalyser();
            this.analyzerNode.fftSize = 256;
            this.analyzerData = new Uint8Array(this.analyzerNode.frequencyBinCount);

            const bufferSize = 2048;
            this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
            this.processorNode.onaudioprocess = (event) => {
                if (!this.isCapturing || this.isMuted) {
                    return;
                }

                const inputData = event.inputBuffer.getChannelData(0);
                const pcmData = this.float32ToInt16(inputData);
                const base64Data = this.arrayBufferToBase64(pcmData.buffer);
                this.onAudioData(base64Data);
            };

            this.sourceNode.connect(this.analyzerNode);
            this.analyzerNode.connect(this.processorNode);
            this.processorNode.connect(this.audioContext.destination);

            this.isCapturing = true;
            this.onStateChange('capturing');
            return true;
        } catch (error) {
            this.onError(error);
            this.onStateChange('error');
            this.stop();
            return false;
        }
    }

    async getMicrophoneStream() {
        const constraintsList = [
            {
                audio: {
                    sampleRate: this.sampleRate,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            },
            {
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            },
            { audio: true }
        ];

        let lastError = null;
        for (const constraints of constraintsList) {
            try {
                return await navigator.mediaDevices.getUserMedia(constraints);
            } catch (error) {
                lastError = error;
                const retryable =
                    error?.name === 'OverconstrainedError' ||
                    error?.name === 'NotReadableError' ||
                    error?.name === 'AbortError' ||
                    error?.name === 'TypeError';
                if (!retryable) {
                    throw error;
                }
            }
        }

        throw lastError || new Error('Failed to access microphone.');
    }

    stop() {
        this.isCapturing = false;

        if (this.processorNode) {
            this.processorNode.disconnect();
            this.processorNode.onaudioprocess = null;
            this.processorNode = null;
        }

        if (this.analyzerNode) {
            this.analyzerNode.disconnect();
            this.analyzerNode = null;
        }

        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        if (this.audioContext) {
            this.audioContext.close().catch(() => { });
            this.audioContext = null;
        }

        this.onStateChange('stopped');
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        this.onStateChange(this.isMuted ? 'muted' : 'capturing');
        return this.isMuted;
    }

    setMuted(muted) {
        this.isMuted = !!muted;
        this.onStateChange(this.isMuted ? 'muted' : 'capturing');
    }

    getAnalyzerData() {
        if (this.analyzerNode && this.analyzerData) {
            this.analyzerNode.getByteFrequencyData(this.analyzerData);
            return this.analyzerData;
        }
        return null;
    }

    float32ToInt16(float32Array) {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const sample = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }
        return int16Array;
    }

    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = '';

        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode(...chunk);
        }

        return btoa(binary);
    }

    static async checkMicrophoneAvailable() {
        try {
            if (!navigator?.mediaDevices?.enumerateDevices) {
                return false;
            }
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.some(device => device.kind === 'audioinput');
        } catch {
            return false;
        }
    }

    static async requestMicrophonePermission() {
        if (!navigator?.mediaDevices?.getUserMedia) {
            return {
                granted: false,
                state: 'unsupported',
                error: new Error('Audio capture is not supported in this browser.')
            };
        }

        let state = 'prompt';
        if (navigator?.permissions?.query) {
            try {
                const permission = await navigator.permissions.query({ name: 'microphone' });
                if (permission?.state) {
                    state = permission.state;
                }
                if (permission?.state === 'denied') {
                    const deniedError = new Error('Microphone permission denied.');
                    deniedError.name = 'NotAllowedError';
                    return { granted: false, state: permission.state, error: deniedError };
                }
            } catch {
                // Safari may not support microphone permission query.
            }
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((track) => track.stop());
            return { granted: true, state: 'granted' };
        } catch (error) {
            return { granted: false, state, error };
        }
    }
}
