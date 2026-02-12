'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioCapture } from '@/lib/audioCapture';
import { AudioPlayback } from '@/lib/audioPlayback';
import { AudioVisualizer } from '@/lib/audioVisualizer';
import { GeminiLive } from '@/lib/geminiLive';

const READY_STATUS_MESSAGE = 'Click below to start talking with Vera';
const DEFAULT_SYSTEM_INSTRUCTION =
    'You are Vera, a warm, intelligent, and helpful AI voice assistant. You speak naturally and conversationally with a friendly and professional tone. Be concise but thorough in your responses. Show personality and empathy in your interactions.';

function getErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === 'string' && error) {
        return error;
    }
    return 'An unexpected error occurred.';
}

export default function Home() {
    const [isConversationActive, setIsConversationActive] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState('disconnected');
    const [statusMessage, setStatusMessage] = useState(READY_STATUS_MESSAGE);
    const [isMuted, setIsMuted] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isAiSpeaking, setIsAiSpeaking] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [toasts, setToasts] = useState([]);
    const [transcripts, setTranscripts] = useState([]);
    const [settings, setSettings] = useState({
        systemInstruction: DEFAULT_SYSTEM_INSTRUCTION
    });
    const [tempSettings, setTempSettings] = useState(settings);

    const audioCaptureRef = useRef(null);
    const audioPlaybackRef = useRef(null);
    const visualizerRef = useRef(null);
    const geminiRef = useRef(null);
    const canvasRef = useRef(null);
    const transcriptEndRef = useRef(null);
    const conversationActiveRef = useRef(false);
    const stopInProgressRef = useRef(false);
    const toastCounterRef = useRef(0);

    useEffect(() => {
        try {
            const saved = localStorage.getItem('voxai-settings');
            if (!saved) {
                return;
            }
            const parsed = JSON.parse(saved);
            if (parsed?.systemInstruction) {
                setSettings(parsed);
                setTempSettings(parsed);
            }
        } catch (error) {
            console.error('Failed to load settings:', error);
        }
    }, []);

    const showToast = useCallback((message, type = 'info') => {
        toastCounterRef.current += 1;
        const id = toastCounterRef.current;
        setToasts(prev => [...prev, { id, message, type }]);

        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 4000);
    }, []);

    const addTranscriptEntry = useCallback((text, speaker) => {
        const normalizedText = typeof text === 'string' ? text.trim() : '';
        if (!normalizedText) {
            return;
        }

        setTranscripts(prev => {
            const last = prev[prev.length - 1];
            if (last?.speaker === speaker && last.text === normalizedText) {
                return prev;
            }

            const next = [
                ...prev,
                {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    speaker,
                    text: normalizedText
                }
            ];

            return next.slice(-60);
        });
    }, []);

    useEffect(() => {
        transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [transcripts]);

    useEffect(() => {
        if (!canvasRef.current || visualizerRef.current) {
            return;
        }
        visualizerRef.current = new AudioVisualizer(canvasRef.current);
    }, []);

    const cleanupResources = useCallback(({ disconnectGemini = true } = {}) => {
        conversationActiveRef.current = false;

        visualizerRef.current?.stop();

        if (audioCaptureRef.current) {
            audioCaptureRef.current.stop();
            audioCaptureRef.current = null;
        }

        if (audioPlaybackRef.current) {
            audioPlaybackRef.current.destroy();
            audioPlaybackRef.current = null;
        }

        if (geminiRef.current && disconnectGemini) {
            geminiRef.current.disconnect();
        }
        geminiRef.current = null;
    }, []);

    useEffect(() => {
        return () => {
            stopInProgressRef.current = true;
            cleanupResources({ disconnectGemini: true });
            if (visualizerRef.current) {
                visualizerRef.current.destroy();
                visualizerRef.current = null;
            }
        };
    }, [cleanupResources]);

    useEffect(() => {
        if (!isSettingsOpen) {
            return;
        }

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                setIsSettingsOpen(false);
            }
        };

        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        window.addEventListener('keydown', onKeyDown);

        return () => {
            window.removeEventListener('keydown', onKeyDown);
            document.body.style.overflow = originalOverflow;
        };
    }, [isSettingsOpen]);

    const finishStoppedState = useCallback((message = READY_STATUS_MESSAGE) => {
        setIsConversationActive(false);
        setConnectionStatus('disconnected');
        setStatusMessage(message);
        setIsListening(false);
        setIsAiSpeaking(false);
        setIsMuted(false);
    }, []);

    const stopConversation = useCallback((options = {}) => {
        const {
            showEndedToast = true,
            disconnectGemini = true,
            nextStatusMessage = READY_STATUS_MESSAGE
        } = options;

        if (stopInProgressRef.current) {
            return;
        }

        stopInProgressRef.current = true;
        setConnectionStatus('disconnecting');
        cleanupResources({ disconnectGemini });
        finishStoppedState(nextStatusMessage);

        if (showEndedToast) {
            showToast('Conversation ended', 'info');
        }

        stopInProgressRef.current = false;
    }, [cleanupResources, finishStoppedState, showToast]);

    const startConversation = useCallback(async () => {
        if (isConversationActive || connectionStatus === 'connecting' || stopInProgressRef.current) {
            return;
        }

        stopInProgressRef.current = false;
        setConnectionStatus('connecting');
        setStatusMessage('Connecting to Vera...');
        setIsListening(false);
        setIsAiSpeaking(false);
        setIsMuted(false);
        setTranscripts([]);

        try {
            const hasMicrophone = await AudioCapture.checkMicrophoneAvailable();
            if (!hasMicrophone) {
                throw new Error('No microphone detected. Connect a microphone and try again.');
            }

            audioPlaybackRef.current = new AudioPlayback({
                onStateChange: (state) => {
                    if (state === 'playing') {
                        setIsAiSpeaking(true);
                        setIsListening(false);
                        setStatusMessage('Vera is speaking...');
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

            geminiRef.current = new GeminiLive({
                systemInstruction: settings.systemInstruction,
                onConnected: () => {
                    if (stopInProgressRef.current) {
                        return;
                    }
                    setConnectionStatus('connected');
                    setStatusMessage('Listening...');
                    setIsListening(true);
                    showToast('Connected to Vera', 'success');
                },
                onDisconnected: () => {
                    if (stopInProgressRef.current || !conversationActiveRef.current) {
                        return;
                    }

                    stopInProgressRef.current = true;
                    cleanupResources({ disconnectGemini: false });
                    finishStoppedState('Connection lost. Click below to reconnect.');
                    showToast('Connection lost. Start a new call to continue.', 'warning');
                    stopInProgressRef.current = false;
                },
                onAudioResponse: (data) => {
                    audioPlaybackRef.current?.addToQueue(data);
                },
                onInterrupted: () => {
                    audioPlaybackRef.current?.interrupt();
                    setIsAiSpeaking(false);
                    if (conversationActiveRef.current) {
                        setIsListening(true);
                        setStatusMessage('Listening...');
                    }
                },
                onTranscript: (text, speaker) => {
                    addTranscriptEntry(text, speaker === 'user' ? 'user' : 'ai');
                },
                onError: (error) => {
                    console.error('Vera error:', error);
                    showToast(getErrorMessage(error), 'error');
                }
            });

            const connected = await geminiRef.current.connect();
            if (!connected) {
                throw new Error('Failed to connect to Vera');
            }

            audioCaptureRef.current = new AudioCapture({
                onAudioData: (data) => {
                    if (geminiRef.current?.isActive()) {
                        geminiRef.current.sendAudio(data);
                    }
                },
                onError: (error) => {
                    if (error?.name === 'NotAllowedError') {
                        showToast('Microphone access denied. Please allow microphone access.', 'error');
                    } else {
                        showToast('Failed to access microphone.', 'error');
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

            const captureStarted = await audioCaptureRef.current.start();
            if (!captureStarted) {
                throw new Error('Failed to start audio capture');
            }

            setIsConversationActive(true);
            conversationActiveRef.current = true;

            if (visualizerRef.current) {
                visualizerRef.current.setSources(audioCaptureRef.current, audioPlaybackRef.current);
                requestAnimationFrame(() => {
                    visualizerRef.current?.resize();
                    visualizerRef.current?.start();
                });
            }
        } catch (error) {
            console.error('Failed to start conversation:', error);
            showToast(getErrorMessage(error), 'error');

            stopInProgressRef.current = true;
            cleanupResources({ disconnectGemini: true });
            finishStoppedState(READY_STATUS_MESSAGE);
            stopInProgressRef.current = false;
        }
    }, [
        addTranscriptEntry,
        cleanupResources,
        connectionStatus,
        finishStoppedState,
        isConversationActive,
        settings.systemInstruction,
        showToast
    ]);

    const toggleMute = useCallback(() => {
        if (!audioCaptureRef.current) {
            return;
        }

        const muted = audioCaptureRef.current.toggleMute();
        setIsMuted(muted);
        showToast(muted ? 'Microphone muted' : 'Microphone unmuted', 'info');
    }, [showToast]);

    const clearTranscript = useCallback(() => {
        setTranscripts([]);
    }, []);

    const saveSettings = useCallback(() => {
        const nextInstruction = tempSettings.systemInstruction.trim() || DEFAULT_SYSTEM_INSTRUCTION;
        const nextSettings = {
            ...tempSettings,
            systemInstruction: nextInstruction
        };

        setSettings(nextSettings);
        setTempSettings(nextSettings);

        try {
            localStorage.setItem('voxai-settings', JSON.stringify(nextSettings));
        } catch (error) {
            console.error('Failed to save settings:', error);
        }

        setIsSettingsOpen(false);
        if (isConversationActive) {
            showToast('Settings saved. Restart the call to apply personality changes.', 'info');
        } else {
            showToast('Settings saved', 'success');
        }
    }, [isConversationActive, showToast, tempSettings]);

    const isBusy = connectionStatus === 'connecting' || connectionStatus === 'disconnecting';
    const statusText = connectionStatus === 'connected'
        ? 'Connected'
        : connectionStatus === 'connecting'
            ? 'Connecting...'
            : connectionStatus === 'disconnecting'
                ? 'Ending...'
                : 'Ready';
    const actionButtonLabel = connectionStatus === 'connecting'
        ? 'Connecting...'
        : connectionStatus === 'disconnecting'
            ? 'Ending...'
            : isConversationActive
                ? 'End Call'
                : 'Talk to Vera';

    return (
        <div id="app">
            <div className="bg-mesh"></div>
            <div className="bg-grid"></div>
            <div className="bg-orbs">
                <div className="orb orb-1"></div>
                <div className="orb orb-2"></div>
                <div className="orb orb-3"></div>
            </div>

            <main className="container">
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
                        <span className="status-text">{statusText}</span>
                    </div>
                </header>

                <section className="conversation-panel">
                    <div className={`ai-avatar ${isAiSpeaking ? 'speaking' : ''} ${isListening ? 'listening' : ''}`}>
                        <div className="avatar-ring"></div>
                        <div className="avatar-core">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
                                <path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
                            </svg>
                        </div>
                    </div>

                    <div className="ai-name">
                        <h2>Vera</h2>
                        <p>Your AI Voice Assistant</p>
                    </div>

                    <div className="status-message">
                        <p>{statusMessage}</p>
                    </div>

                    <div className={`visualizer-container ${isConversationActive ? 'active' : ''}`}>
                        <canvas ref={canvasRef} id="audioVisualizer" width="400" height="80"></canvas>
                    </div>

                    <div className={`transcript-panel ${transcripts.length > 0 ? 'active' : ''}`}>
                        <div className="transcript-header">
                            <h3>Live Transcript</h3>
                            <button
                                className="transcript-clear"
                                onClick={clearTranscript}
                                disabled={transcripts.length === 0}
                                aria-label="Clear transcript"
                            >
                                Clear
                            </button>
                        </div>

                        <div
                            className="transcript-list"
                            role="log"
                            aria-live="polite"
                            aria-label="Conversation transcript"
                        >
                            {transcripts.length === 0 ? (
                                <p className="transcript-empty">
                                    Transcript will appear here during your conversation.
                                </p>
                            ) : (
                                transcripts.map((entry) => (
                                    <div
                                        key={entry.id}
                                        className={`transcript-item ${entry.speaker === 'user' ? 'user' : 'ai'}`}
                                    >
                                        <span className="transcript-speaker">
                                            {entry.speaker === 'user' ? 'You' : 'Vera'}
                                        </span>
                                        <p>{entry.text}</p>
                                    </div>
                                ))
                            )}
                            <div ref={transcriptEndRef} />
                        </div>
                    </div>
                </section>

                <section className="control-panel">
                    <button
                        className={`action-btn ${isConversationActive ? 'active' : ''}`}
                        onClick={isConversationActive ? stopConversation : startConversation}
                        disabled={isBusy}
                        aria-busy={isBusy}
                    >
                        <div className="btn-content">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" x2="12" y1="19" y2="22" />
                            </svg>
                            <span className="btn-text">{actionButtonLabel}</span>
                        </div>
                        <div className="btn-ripple"></div>
                    </button>

                    <div className="secondary-controls">
                        <button
                            className={`control-btn ${isMuted ? 'muted' : ''}`}
                            onClick={toggleMute}
                            title="Mute microphone"
                            aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                            aria-pressed={isMuted}
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
                            aria-label="Open settings"
                            disabled={isBusy}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                        </button>
                    </div>
                </section>
            </main>

            <div
                className={`modal-overlay ${isSettingsOpen ? 'active' : ''}`}
                onClick={() => setIsSettingsOpen(false)}
                aria-hidden={!isSettingsOpen}
            >
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
                            <p className="helper-text helper-text-success">
                                Secured through a server-side token endpoint.
                            </p>
                        </div>
                        <div className="form-group">
                            <label htmlFor="systemInstruction">Vera&apos;s Personality</label>
                            <textarea
                                id="systemInstruction"
                                rows="4"
                                placeholder="Describe how Vera should behave..."
                                value={tempSettings.systemInstruction}
                                onChange={e => setTempSettings({ ...tempSettings, systemInstruction: e.target.value })}
                            />
                            <p className="helper-text">
                                Customize how Vera responds and interacts with you.
                            </p>
                        </div>
                    </div>
                    <div className="modal-footer">
                        <button className="btn btn-secondary" onClick={() => setIsSettingsOpen(false)}>Cancel</button>
                        <button className="btn btn-primary" onClick={saveSettings}>Save</button>
                    </div>
                </div>
            </div>

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
