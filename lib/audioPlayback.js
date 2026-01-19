/**
 * Audio Playback Module
 * Handles playback of PCM audio responses from Gemini Live API
 * Improved with immediate interrupt capability for clean voice handoff
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

        // Track ALL active sources for proper interruption
        this.activeSources = [];
        this.nextStartTime = 0;
        this.isScheduling = false;
        this.isInterrupted = false;

        this.init();
    }

    init() {
        this.audioContext = new AudioContext({
            sampleRate: this.sampleRate
        });

        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = 1.0;
        this.gainNode.connect(this.audioContext.destination);

        this.analyzerNode = this.audioContext.createAnalyser();
        this.analyzerNode.fftSize = 256;
        this.analyzerData = new Uint8Array(this.analyzerNode.frequencyBinCount);
        this.analyzerNode.connect(this.gainNode);
    }

    addToQueue(base64Data) {
        // If interrupted, ignore new audio until explicitly resumed
        if (this.isInterrupted) return;

        // Decode base64 to ArrayBuffer
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Convert to Int16Array (PCM)
        const int16Array = new Int16Array(bytes.buffer);

        // Convert to Float32Array for Web Audio API
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        this.pendingBuffers.push(float32Array);

        // Start scheduling if not already
        if (!this.isScheduling) {
            this.scheduleBuffers();
        }
    }

    async scheduleBuffers() {
        if (this.pendingBuffers.length === 0 || this.isInterrupted) {
            this.isScheduling = false;
            if (!this.isPlaying && !this.isInterrupted) {
                this.onPlaybackEnd();
            }
            return;
        }

        this.isScheduling = true;

        // Resume audio context if suspended
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        if (!this.isPlaying) {
            this.isPlaying = true;
            this.onStateChange('playing');
            this.nextStartTime = this.audioContext.currentTime;
        }

        // Process all pending buffers
        while (this.pendingBuffers.length > 0 && !this.isInterrupted) {
            const audioData = this.pendingBuffers.shift();

            // Create audio buffer
            const audioBuffer = this.audioContext.createBuffer(
                1, // mono
                audioData.length,
                this.sampleRate
            );

            audioBuffer.copyToChannel(audioData, 0);

            // Create buffer source
            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.analyzerNode);

            // Schedule at the right time for seamless playback
            const startTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
            source.start(startTime);

            // Track this source for interruption
            this.activeSources.push(source);

            // Calculate when this buffer ends
            this.nextStartTime = startTime + audioBuffer.duration;

            // Clean up when source ends
            source.onended = () => {
                const index = this.activeSources.indexOf(source);
                if (index > -1) {
                    this.activeSources.splice(index, 1);
                }

                // Check if playback is complete
                if (this.activeSources.length === 0 && this.pendingBuffers.length === 0 && !this.isInterrupted) {
                    this.isPlaying = false;
                    this.onStateChange('idle');
                    this.onPlaybackEnd();
                }
            };
        }

        this.isScheduling = false;
    }

    interrupt() {
        // Set interrupt flag to prevent new audio
        this.isInterrupted = true;

        // Clear all pending buffers immediately
        this.pendingBuffers = [];

        // Stop ALL active audio sources immediately
        for (const source of this.activeSources) {
            try {
                source.stop(0); // Stop immediately
                source.disconnect();
            } catch (e) {
                // Ignore errors if already stopped
            }
        }
        this.activeSources = [];

        // Fade out quickly to avoid audio pop
        if (this.gainNode) {
            const now = this.audioContext.currentTime;
            this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
            this.gainNode.gain.linearRampToValueAtTime(0, now + 0.05);

            // Restore gain after fade
            setTimeout(() => {
                if (this.gainNode) {
                    this.gainNode.gain.setValueAtTime(1.0, this.audioContext.currentTime);
                }
            }, 60);
        }

        this.isPlaying = false;
        this.isScheduling = false;
        this.nextStartTime = 0;
        this.onStateChange('idle');

        // Reset interrupt flag after a short delay to allow new audio
        setTimeout(() => {
            this.isInterrupted = false;
        }, 100);
    }

    setVolume(volume) {
        if (this.gainNode) {
            this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
        }
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

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }
}
