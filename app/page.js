'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioCapture } from '@/lib/audioCapture';
import { AudioPlayback } from '@/lib/audioPlayback';
import { AudioVisualizer } from '@/lib/audioVisualizer';
import { GeminiLive } from '@/lib/geminiLive';

export default function Home() {
    // State
    const [isConversationActive, setIsConversationActive] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState('disconnected');
    const [statusMessage, setStatusMessage] = useState('Click below to start talking with Véra');
    const [isMuted, setIsMuted] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isAiSpeaking, setIsAiSpeaking] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [toasts, setToasts] = useState([]);
    const [settings, setSettings] = useState({
        systemInstruction: 'You are Véra, a warm, intelligent, and helpful AI voice assistant. You speak naturally and conversationally, with a friendly yet professional tone. Be concise but thorough in your responses. Show personality and empathy in your interactions.'
    });
    const [tempSettings, setTempSettings] = useState(settings);

    // Refs
    const audioCaptureRef = useRef(null);
    const audioPlaybackRef = useRef(null);
    const visualizerRef = useRef(null);
    const geminiRef = useRef(null);
    const canvasRef = useRef(null);
    const visualizerContainerRef = useRef(null);
    const conversationActiveRef = useRef(false);

    // Load settings from localStorage on mount
    useEffect(() => {
        const saved = localStorage.getItem('voxai-settings');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                setSettings(parsed);
                setTempSettings(parsed);
            } catch (e) {
                console.error('Failed to parse settings:', e);
            }
        }
    }, []);

    // Toast helper
    const showToast = useCallback((message, type = 'info') => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 4000);
    }, []);

    // Initialize visualizer when canvas is ready
    useEffect(() => {
        if (canvasRef.current && !visualizerRef.current) {
            visualizerRef.current = new AudioVisualizer(canvasRef.current);
        }
    }, [canvasRef.current]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cleanup();
        };
    }, []);

    const cleanup = () => {
        conversationActiveRef.current = false;
        if (visualizerRef.current) {
            visualizerRef.current.stop();
        }
        if (audioCaptureRef.current) {
            audioCaptureRef.current.stop();
            audioCaptureRef.current = null;
        }
        if (audioPlaybackRef.current) {
            audioPlaybackRef.current.destroy();
            audioPlaybackRef.current = null;
        }
        if (geminiRef.current) {
            geminiRef.current.disconnect();
            geminiRef.current = null;
        }
    };

    const startConversation = async () => {
        setConnectionStatus('connecting');
        setStatusMessage('Connecting to Véra...');

        try {
            // Initialize audio playback
            audioPlaybackRef.current = new AudioPlayback({
                onStateChange: (state) => {
                    if (state === 'playing') {
                        setIsAiSpeaking(true);
                        setIsListening(false);
                        setStatusMessage('Véra is speaking...');
                    } else {
                        setIsAiSpeaking(false);
                        if (conversationActiveRef.current) {
                            setIsListening(true);
                            setStatusMessage('Listening...');
                        }
                    }
                },
                onPlaybackEnd: () => {
                    if (conversationActiveRef.current) {
                        setIsListening(true);
                        setStatusMessage('Listening...');
                    }
                }
            });

            // Initialize Gemini (uses server-side API key)
            geminiRef.current = new GeminiLive({
                systemInstruction: settings.systemInstruction,
                onConnected: () => {
                    setConnectionStatus('connected');
                    setStatusMessage('Listening...');
                    setIsListening(true);
                    showToast('Connected to Véra', 'success');
                },
                onDisconnected: () => {
                    if (conversationActiveRef.current) {
                        showToast('Connection lost. Please try again.', 'warning');
                        stopConversation();
                    }
                },
                onAudioResponse: (data) => {
                    if (audioPlaybackRef.current) {
                        audioPlaybackRef.current.addToQueue(data);
                    }
                },
                onInterrupted: () => {
                    // User interrupted Véra - stop playback immediately
                    if (audioPlaybackRef.current) {
                        audioPlaybackRef.current.interrupt();
                    }
                    // Switch to listening state
                    setIsAiSpeaking(false);
                    setIsListening(true);
                    setStatusMessage('Listening...');
                },
                onError: (error) => {
                    console.error('Véra error:', error);
                    showToast(error.message || 'An error occurred', 'error');
                }
            });

            // Connect to Gemini
            const connected = await geminiRef.current.connect();
            if (!connected) {
                throw new Error('Failed to connect to Véra');
            }

            // Initialize audio capture
            audioCaptureRef.current = new AudioCapture({
                onAudioData: (data) => {
                    if (geminiRef.current && geminiRef.current.isActive()) {
                        geminiRef.current.sendAudio(data);
                    }
                },
                onError: (error) => {
                    if (error.name === 'NotAllowedError') {
                        showToast('Microphone access denied. Please allow microphone access.', 'error');
                    } else {
                        showToast('Failed to access microphone', 'error');
                    }
                },
                onStateChange: (state) => {
                    if (state === 'muted') {
                        setIsListening(false);
                    } else if (state === 'capturing' && conversationActiveRef.current) {
                        setIsListening(true);
                    }
                }
            });

            // Start capturing
            const captureStarted = await audioCaptureRef.current.start();
            if (!captureStarted) {
                throw new Error('Failed to start audio capture');
            }

            // Set up visualizer
            if (visualizerRef.current) {
                visualizerRef.current.setSources(audioCaptureRef.current, audioPlaybackRef.current);
                visualizerRef.current.start();
            }

            setIsConversationActive(true);
            conversationActiveRef.current = true;

        } catch (error) {
            console.error('Failed to start conversation:', error);
            showToast(error.message || 'Failed to start conversation', 'error');
            cleanup();
            setConnectionStatus('disconnected');
            setStatusMessage('Click below to start talking with Véra');
        }
    };

    const stopConversation = () => {
        cleanup();
        setIsConversationActive(false);
        setConnectionStatus('disconnected');
        setStatusMessage('Click below to start talking with Véra');
        setIsListening(false);
        setIsAiSpeaking(false);
        setIsMuted(false);
        showToast('Conversation ended', 'info');
    };

    const toggleMute = () => {
        if (!audioCaptureRef.current) return;
        const muted = audioCaptureRef.current.toggleMute();
        setIsMuted(muted);
        showToast(muted ? 'Microphone muted' : 'Microphone unmuted', 'info');
    };

    const saveSettings = () => {
        setSettings(tempSettings);
        localStorage.setItem('voxai-settings', JSON.stringify(tempSettings));
        setIsSettingsOpen(false);
        showToast('Settings saved', 'success');
    };

    return (
        <div id="app">
            {/* Animated Background */}
            <div className="bg-mesh"></div>
            <div className="bg-grid"></div>
            <div className="bg-orbs">
                <div className="orb orb-1"></div>
                <div className="orb orb-2"></div>
                <div className="orb orb-3"></div>
            </div>

            {/* Main Container */}
            <main className="container">
                {/* Header */}
                <header className="header">
                    <div className="logo">
                        <div className="logo-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" x2="12" y1="19" y2="22" />
                            </svg>
                        </div>
                        <h1>VoxAI</h1>
                    </div>
                    <div className={`connection-status ${connectionStatus}`}>
                        <span className="status-dot"></span>
                        <span className="status-text">
                            {connectionStatus === 'connected' ? 'Connected' :
                                connectionStatus === 'connecting' ? 'Connecting...' : 'Ready'}
                        </span>
                    </div>
                </header>

                {/* Conversation Panel */}
                <section className="conversation-panel">
                    {/* AI Avatar */}
                    <div className={`ai-avatar ${isAiSpeaking ? 'speaking' : ''} ${isListening ? 'listening' : ''}`}>
                        <div className="avatar-ring"></div>
                        <div className="avatar-core">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
                                <path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
                            </svg>
                        </div>
                    </div>

                    {/* AI Name */}
                    <div className="ai-name">
                        <h2>Véra</h2>
                        <p>Your AI Voice Assistant</p>
                    </div>

                    {/* Status Message */}
                    <div className="status-message">
                        <p>{statusMessage}</p>
                    </div>

                    {/* Audio Visualizer */}
                    <div
                        ref={visualizerContainerRef}
                        className={`visualizer-container ${isConversationActive ? 'active' : ''}`}
                    >
                        <canvas ref={canvasRef} id="audioVisualizer" width="400" height="80"></canvas>
                    </div>
                </section>

                {/* Control Panel */}
                <section className="control-panel">
                    {/* Main Action Button */}
                    <button
                        className={`action-btn ${isConversationActive ? 'active' : ''}`}
                        onClick={isConversationActive ? stopConversation : startConversation}
                    >
                        <div className="btn-content">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" x2="12" y1="19" y2="22" />
                            </svg>
                            <span className="btn-text">
                                {isConversationActive ? 'End Call' : 'Talk to Véra'}
                            </span>
                        </div>
                        <div className="btn-ripple"></div>
                    </button>

                    {/* Secondary Controls */}
                    <div className="secondary-controls">
                        <button
                            className={`control-btn ${isMuted ? 'muted' : ''}`}
                            onClick={toggleMute}
                            title="Mute microphone"
                            disabled={!isConversationActive}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                {isMuted ? (
                                    <>
                                        <line x1="1" y1="1" x2="23" y2="23" />
                                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
                                        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                                        <line x1="12" x2="12" y1="19" y2="22" />
                                    </>
                                ) : (
                                    <>
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" x2="12" y1="19" y2="22" />
                                    </>
                                )}
                            </svg>
                        </button>
                        <button
                            className="control-btn"
                            onClick={() => {
                                setTempSettings(settings);
                                setIsSettingsOpen(true);
                            }}
                            title="Settings"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                        </button>
                    </div>
                </section>
            </main>

            {/* Settings Modal */}
            <div className={`modal-overlay ${isSettingsOpen ? 'active' : ''}`} onClick={() => setIsSettingsOpen(false)}>
                <div className="modal" onClick={e => e.stopPropagation()}>
                    <div className="modal-header">
                        <h2>Settings</h2>
                        <button className="modal-close" onClick={() => setIsSettingsOpen(false)}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                        </button>
                    </div>
                    <div className="modal-body">
                        <div className="form-group">
                            <label>API Status</label>
                            <p className="helper-text" style={{ fontSize: '0.9rem', color: 'var(--success)' }}>
                                🔒 Secured server-side
                            </p>
                        </div>
                        <div className="form-group">
                            <label>Véra&apos;s Personality</label>
                            <textarea
                                id="systemInstruction"
                                rows="4"
                                placeholder="Describe how Véra should behave..."
                                value={tempSettings.systemInstruction}
                                onChange={e => setTempSettings({ ...tempSettings, systemInstruction: e.target.value })}
                            />
                            <p className="helper-text">
                                Customize how Véra responds and interacts with you.
                            </p>
                        </div>
                    </div>
                    <div className="modal-footer">
                        <button className="btn btn-secondary" onClick={() => setIsSettingsOpen(false)}>Cancel</button>
                        <button className="btn btn-primary" onClick={saveSettings}>Save</button>
                    </div>
                </div>
            </div>

            {/* Toast Notifications */}
            <div className="toast-container">
                {toasts.map(toast => (
                    <div key={toast.id} className={`toast ${toast.type}`}>
                        <span className="toast-message">{toast.message}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
