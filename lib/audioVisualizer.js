/**
 * Audio Visualizer Module
 * Canvas-based waveform visualization for audio input/output.
 */

export class AudioVisualizer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.animationId = null;
        this.isRunning = false;

        this.captureSource = null;
        this.playbackSource = null;

        this.barWidth = 4;
        this.barGap = 2;
        this.barRadius = 2;
        this.minBarHeight = 4;

        this.captureColor = '#10b981';
        this.playbackColor = '#6366f1';
        this.idleColor = 'rgba(255, 255, 255, 0.2)';

        this.smoothedData = null;
        this.smoothingFactor = 0.3;
        this.resizeHandler = this.resize.bind(this);

        this.resize();
        if (typeof window !== 'undefined') {
            window.addEventListener('resize', this.resizeHandler);
        }
    }

    resize() {
        if (!this.canvas || !this.ctx) {
            return;
        }

        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);

        this.canvas.width = Math.floor(width * dpr);
        this.canvas.height = Math.floor(height * dpr);
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this.width = width;
        this.height = height;
        this.numBars = Math.max(1, Math.floor(this.width / (this.barWidth + this.barGap)));
        this.smoothedData = new Array(this.numBars).fill(0);
    }

    setSources(captureSource, playbackSource) {
        this.captureSource = captureSource;
        this.playbackSource = playbackSource;
    }

    start() {
        if (this.isRunning) {
            return;
        }
        this.isRunning = true;
        this.animate();
    }

    stop() {
        this.isRunning = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.clear();
    }

    animate() {
        if (!this.isRunning) {
            return;
        }
        this.draw();
        this.animationId = requestAnimationFrame(() => this.animate());
    }

    draw() {
        if (!this.ctx) {
            return;
        }

        this.ctx.clearRect(0, 0, this.width, this.height);

        let data = null;
        let color = this.idleColor;
        let isActive = false;

        if (this.playbackSource?.isCurrentlyPlaying()) {
            data = this.playbackSource.getAnalyzerData();
            color = this.playbackColor;
            isActive = true;
        } else if (this.captureSource && !this.captureSource.isMuted) {
            data = this.captureSource.getAnalyzerData();
            color = this.captureColor;
            isActive = true;
        }

        this.drawBars(data, color, isActive);
    }

    drawBars(data, color, isActive) {
        const centerY = this.height / 2;
        const maxHeight = this.height * 0.8;
        const totalWidth = this.numBars * (this.barWidth + this.barGap) - this.barGap;
        const startX = (this.width - totalWidth) / 2;

        this.ctx.shadowBlur = 0;
        for (let i = 0; i < this.numBars; i++) {
            let value = 0;

            if (data && data.length > 0) {
                const dataIndex = Math.floor((i / this.numBars) * data.length);
                value = data[dataIndex] / 255;
            }

            if (!isActive) {
                value = 0.1 + Math.sin(Date.now() / 1000 + i * 0.2) * 0.05;
            }

            this.smoothedData[i] = this.smoothedData[i] * (1 - this.smoothingFactor) +
                value * this.smoothingFactor;

            const height = Math.max(this.minBarHeight, this.smoothedData[i] * maxHeight);
            const x = startX + i * (this.barWidth + this.barGap);
            const y = centerY - height / 2;

            this.ctx.fillStyle = color;
            this.ctx.beginPath();
            this.roundRect(x, y, this.barWidth, height, this.barRadius);
            this.ctx.fill();

            if (isActive && value > 0.3) {
                this.ctx.shadowColor = color;
                this.ctx.shadowBlur = 10;
                this.ctx.fill();
                this.ctx.shadowBlur = 0;
            }
        }
    }

    roundRect(x, y, width, height, radius) {
        this.ctx.moveTo(x + radius, y);
        this.ctx.lineTo(x + width - radius, y);
        this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        this.ctx.lineTo(x + width, y + height - radius);
        this.ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        this.ctx.lineTo(x + radius, y + height);
        this.ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        this.ctx.lineTo(x, y + radius);
        this.ctx.quadraticCurveTo(x, y, x + radius, y);
        this.ctx.closePath();
    }

    clear() {
        if (!this.ctx) {
            return;
        }
        this.ctx.clearRect(0, 0, this.width, this.height);
        this.smoothedData = new Array(this.numBars).fill(0);
        this.drawBars(null, this.idleColor, false);
    }

    destroy() {
        this.stop();
        if (typeof window !== 'undefined') {
            window.removeEventListener('resize', this.resizeHandler);
        }
        this.captureSource = null;
        this.playbackSource = null;
    }
}
