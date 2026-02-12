/**
 * Audio Playback Module
 * Handles playback of PCM audio responses from Gemini Live API.
 */

export class AudioPlayback {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 24000;
        this.onStateChange = options.onStateChange || (() => { });
        this.onPlaybackEnd = options.onPlaybackEnd || (() => { });

        this.audioContext = null;
        this.pendingBuffers = [];
        this.isPlaying = false;
        this.gainNode = null;
        this.analyzerNode = null;
        this.analyzerData = null;
        this.activeSources = [];
        this.nextStartTime = 0;
        this.isScheduling = false;
        this.isInterrupted = false;
        this.interruptResetTimer = null;

        this.init();
    }

    init() {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
            throw new Error('Web Audio API is not supported in this browser.');
        }

        this.audioContext = new AudioContextCtor({
            sampleRate: this.sampleRate
        });

        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = 1.0;

        this.analyzerNode = this.audioContext.createAnalyser();
        this.analyzerNode.fftSize = 256;
        this.analyzerData = new Uint8Array(this.analyzerNode.frequencyBinCount);

        this.analyzerNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
    }

    addToQueue(base64Data) {
        if (this.isInterrupted || !base64Data) {
            return;
        }

        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768;
        }

        this.pendingBuffers.push(float32Array);
        void this.scheduleBuffers();
    }

    async scheduleBuffers() {
        if (this.isScheduling || this.isInterrupted || !this.audioContext) {
            return;
        }

        this.isScheduling = true;

        try {
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            if (!this.isPlaying && this.pendingBuffers.length > 0) {
                this.isPlaying = true;
                this.onStateChange('playing');
                this.nextStartTime = this.audioContext.currentTime;
            }

            while (this.pendingBuffers.length > 0 && !this.isInterrupted) {
                const audioData = this.pendingBuffers.shift();
                if (!audioData) {
                    continue;
                }

                const audioBuffer = this.audioContext.createBuffer(1, audioData.length, this.sampleRate);
                audioBuffer.copyToChannel(audioData, 0);

                const source = this.audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.analyzerNode);

                const startTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
                source.start(startTime);
                this.nextStartTime = startTime + audioBuffer.duration;
                this.activeSources.push(source);

                source.onended = () => {
                    const index = this.activeSources.indexOf(source);
                    if (index >= 0) {
                        this.activeSources.splice(index, 1);
                    }

                    if (this.activeSources.length === 0 && this.pendingBuffers.length === 0 && !this.isInterrupted) {
                        this.isPlaying = false;
                        this.onStateChange('idle');
                        this.onPlaybackEnd();
                    }
                };
            }
        } finally {
            this.isScheduling = false;
        }
    }

    interrupt() {
        this.isInterrupted = true;
        this.pendingBuffers = [];

        for (const source of this.activeSources) {
            try {
                source.stop(0);
                source.disconnect();
            } catch {
                // Ignore source stop errors.
            }
        }
        this.activeSources = [];

        if (this.gainNode && this.audioContext) {
            const now = this.audioContext.currentTime;
            this.gainNode.gain.cancelScheduledValues(now);
            this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
            this.gainNode.gain.linearRampToValueAtTime(0, now + 0.05);
        }

        this.isPlaying = false;
        this.isScheduling = false;
        this.nextStartTime = 0;
        this.onStateChange('idle');

        if (this.interruptResetTimer) {
            clearTimeout(this.interruptResetTimer);
        }
        this.interruptResetTimer = setTimeout(() => {
            if (!this.gainNode || !this.audioContext) {
                return;
            }
            this.gainNode.gain.setValueAtTime(1.0, this.audioContext.currentTime);
            this.isInterrupted = false;
        }, 120);
    }

    setVolume(volume) {
        if (!this.gainNode) {
            return;
        }
        this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }

    getAnalyzerData() {
        if (this.analyzerNode && this.analyzerData && this.isPlaying) {
            this.analyzerNode.getByteFrequencyData(this.analyzerData);
            return this.analyzerData;
        }
        return null;
    }

    isCurrentlyPlaying() {
        return this.isPlaying;
    }

    destroy() {
        this.interrupt();
        if (this.interruptResetTimer) {
            clearTimeout(this.interruptResetTimer);
            this.interruptResetTimer = null;
        }

        if (this.audioContext) {
            this.audioContext.close().catch(() => { });
            this.audioContext = null;
        }

        this.pendingBuffers = [];
        this.activeSources = [];
        this.gainNode = null;
        this.analyzerNode = null;
        this.analyzerData = null;
    }
}
