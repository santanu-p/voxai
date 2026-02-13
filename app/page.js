'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioCapture } from '@/lib/audioCapture';
import { AudioPlayback } from '@/lib/audioPlayback';
import { AudioVisualizer } from '@/lib/audioVisualizer';
import { GeminiLive } from '@/lib/geminiLive';

const READY_STATUS_MESSAGE = 'Click below to start talking with Noa';
const SETTINGS_STORAGE_KEY = 'noa-live-settings';
const HISTORY_STORAGE_KEY = 'noa-live-history';
const MAX_HISTORY_ITEMS = 30;
const MAX_TRANSCRIPT_ITEMS = 120;
const DEFAULT_VOICE_NAME = 'Aoede';
const DEFAULT_MODE = 'vad';
const VOICE_OPTIONS = [
    { value: 'Aoede', label: 'Aoede (Balanced)' },
    { value: 'Kore', label: 'Kore (Clear)' },
    { value: 'Leda', label: 'Leda (Warm)' },
    { value: 'Puck', label: 'Puck (Energetic)' },
    { value: 'Zephyr', label: 'Zephyr (Bright)' }
];

const DEFAULT_SYSTEM_INSTRUCTION =
    'You are Noa, a warm, intelligent, and helpful AI voice assistant. You speak naturally and conversationally with a friendly and professional tone. Be concise but thorough in your responses. Show personality and empathy in your interactions.';
const DEFAULT_SETTINGS = {
    systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
    voiceName: DEFAULT_VOICE_NAME,
    conversationMode: DEFAULT_MODE
};

function getErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === 'string' && error) {
        return error;
    }
    return 'An unexpected error occurred.';
}

function isMobileBrowser() {
    if (typeof navigator === 'undefined') {
        return false;
    }
    return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function isInAppBrowser() {
    if (typeof navigator === 'undefined') {
        return false;
    }
    const ua = navigator.userAgent || '';
    return /FBAN|FBAV|Instagram|Line|LinkedInApp|Twitter|wv\)|WebView/i.test(ua);
}

function getMicrophoneErrorMessage(error) {
    const errorName = error?.name || '';
    const message = typeof error?.message === 'string' ? error.message : '';

    if (errorName === 'NotAllowedError' || errorName === 'SecurityError') {
        if (isMobileBrowser() && isInAppBrowser()) {
            return 'Microphone access is blocked in this in-app browser. Open the site in Safari or Chrome and allow microphone permission.';
        }
        if (isMobileBrowser()) {
            return 'Microphone permission is blocked. Allow microphone access in browser site settings and reload this page.';
        }
        return 'Microphone access denied. Please allow microphone access.';
    }

    if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') {
        return 'No microphone was found on this device.';
    }

    if (errorName === 'NotReadableError' || errorName === 'TrackStartError') {
        return 'Microphone is currently in use by another app. Close other apps and try again.';
    }

    if (errorName === 'OverconstrainedError') {
        return 'This device does not support the current microphone settings. Please try again.';
    }

    if (message) {
        return message;
    }

    return 'Failed to access microphone.';
}

function isSecureMicContext() {
    if (typeof window === 'undefined') {
        return true;
    }
    if (window.isSecureContext) {
        return true;
    }
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1';
}

function normalizeConversationMode(value) {
    return value === 'push-to-talk' ? 'push-to-talk' : 'vad';
}

function normalizeVoiceName(value) {
    return VOICE_OPTIONS.some((voice) => voice.value === value) ? value : DEFAULT_VOICE_NAME;
}

function migrateAssistantName(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return DEFAULT_SYSTEM_INSTRUCTION;
    }
    return value.replace(/\bVera\b/g, 'Noa');
}

function formatTimestamp(value) {
    try {
        return new Date(value).toLocaleString();
    } catch {
        return 'Unknown time';
    }
}

function buildHistoryText(conversations) {
    if (!Array.isArray(conversations) || conversations.length === 0) {
        return 'No conversation history found.';
    }

    return conversations.map((conversation, index) => {
        const header = [
            `Conversation ${index + 1}`,
            `Started: ${formatTimestamp(conversation.startedAt)}`,
            `Ended: ${formatTimestamp(conversation.endedAt)}`,
            `Voice: ${conversation.voiceName || DEFAULT_VOICE_NAME}`,
            `Mode: ${conversation.conversationMode || DEFAULT_MODE}`,
            `Duration: ${Math.round((conversation.durationMs || 0) / 1000)}s`,
            ''
        ].join('\n');

        const transcript = (conversation.transcript || [])
            .map((entry) => `[${entry.speaker === 'user' ? 'You' : 'Noa'}] ${entry.text}`)
            .join('\n');

        return `${header}${transcript}`;
    }).join('\n\n----------------------------------------\n\n');
}

function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

export default function Home() {
    const [isConversationActive, setIsConversationActive] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState('disconnected');
    const [statusMessage, setStatusMessage] = useState(READY_STATUS_MESSAGE);
    const [isMuted, setIsMuted] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isAiSpeaking, setIsAiSpeaking] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [isPushToTalkPressed, setIsPushToTalkPressed] = useState(false);
    const [toasts, setToasts] = useState([]);
    const [transcripts, setTranscripts] = useState([]);
    const [conversationHistory, setConversationHistory] = useState([]);
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const [tempSettings, setTempSettings] = useState(DEFAULT_SETTINGS);

    const audioCaptureRef = useRef(null);
    const audioPlaybackRef = useRef(null);
    const visualizerRef = useRef(null);
    const geminiRef = useRef(null);
    const canvasRef = useRef(null);
    const transcriptEndRef = useRef(null);
    const conversationActiveRef = useRef(false);
    const stopInProgressRef = useRef(false);
    const pushToTalkPressedRef = useRef(false);
    const conversationStartedAtRef = useRef(null);
    const conversationPersistedRef = useRef(false);
    const transcriptsRef = useRef([]);
    const settingsRef = useRef(settings);
    const toastCounterRef = useRef(0);

    useEffect(() => {
        transcriptsRef.current = transcripts;
    }, [transcripts]);

    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    useEffect(() => {
        try {
            const savedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
            if (savedSettings) {
                const parsedSettings = JSON.parse(savedSettings);
                const merged = {
                    systemInstruction: migrateAssistantName(parsedSettings?.systemInstruction),
                    voiceName: normalizeVoiceName(parsedSettings?.voiceName),
                    conversationMode: normalizeConversationMode(parsedSettings?.conversationMode)
                };
                setSettings(merged);
                setTempSettings(merged);
            }
        } catch (error) {
            console.error('Failed to load settings:', error);
        }

        try {
            const savedHistory = localStorage.getItem(HISTORY_STORAGE_KEY);
            if (savedHistory) {
                const parsedHistory = JSON.parse(savedHistory);
                if (Array.isArray(parsedHistory)) {
                    setConversationHistory(parsedHistory);
                }
            }
        } catch (error) {
            console.error('Failed to load history:', error);
        }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(conversationHistory));
        } catch (error) {
            console.error('Failed to persist conversation history:', error);
        }
    }, [conversationHistory]);

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
                    timestamp: Date.now(),
                    speaker,
                    text: normalizedText
                }
            ];

            return next.slice(-MAX_TRANSCRIPT_ITEMS);
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
        pushToTalkPressedRef.current = false;

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

    const persistCurrentConversation = useCallback((reason = 'ended') => {
        if (conversationPersistedRef.current) {
            return;
        }

        const transcriptSnapshot = transcriptsRef.current;
        if (!Array.isArray(transcriptSnapshot) || transcriptSnapshot.length === 0) {
            return;
        }

        const endedAt = Date.now();
        const startedAt = conversationStartedAtRef.current || endedAt;

        const conversation = {
            id: `conv-${endedAt}-${Math.random().toString(36).slice(2, 8)}`,
            startedAt,
            endedAt,
            reason,
            durationMs: Math.max(0, endedAt - startedAt),
            voiceName: settingsRef.current.voiceName || DEFAULT_VOICE_NAME,
            conversationMode: settingsRef.current.conversationMode || DEFAULT_MODE,
            transcript: transcriptSnapshot.map((entry) => ({
                timestamp: entry.timestamp || endedAt,
                speaker: entry.speaker === 'user' ? 'user' : 'ai',
                text: entry.text
            }))
        };

        setConversationHistory((prev) => [conversation, ...prev].slice(0, MAX_HISTORY_ITEMS));
        conversationPersistedRef.current = true;
    }, []);

    const finishStoppedState = useCallback((message = READY_STATUS_MESSAGE) => {
        setIsConversationActive(false);
        setConnectionStatus('disconnected');
        setStatusMessage(message);
        setIsListening(false);
        setIsAiSpeaking(false);
        setIsMuted(false);
        setIsPushToTalkPressed(false);
    }, []);

    const stopConversation = useCallback((options = {}) => {
        const {
            showEndedToast = true,
            disconnectGemini = true,
            nextStatusMessage = READY_STATUS_MESSAGE,
            reason = 'ended'
        } = options;

        if (stopInProgressRef.current) {
            return;
        }

        stopInProgressRef.current = true;
        setConnectionStatus('disconnecting');
        persistCurrentConversation(reason);
        cleanupResources({ disconnectGemini });
        finishStoppedState(nextStatusMessage);

        if (showEndedToast) {
            showToast('Conversation ended', 'info');
        }

        stopInProgressRef.current = false;
    }, [cleanupResources, finishStoppedState, persistCurrentConversation, showToast]);

    const startConversation = useCallback(async () => {
        if (isConversationActive || connectionStatus === 'connecting' || stopInProgressRef.current) {
            return;
        }

        if (!isSecureMicContext()) {
            showToast('Microphone access on mobile requires HTTPS. Open this site using https://.', 'error');
            return;
        }

        stopInProgressRef.current = false;
        setConnectionStatus('connecting');
        setStatusMessage('Starting microphone...');
        setIsListening(false);
        setIsAiSpeaking(false);
        setIsMuted(false);
        setIsPushToTalkPressed(false);
        setTranscripts([]);
        conversationPersistedRef.current = false;
        conversationStartedAtRef.current = Date.now();
        pushToTalkPressedRef.current = false;

        try {
            const micPermission = await AudioCapture.requestMicrophonePermission();
            if (!micPermission.granted) {
                throw new Error(getMicrophoneErrorMessage(micPermission.error));
            }

            audioCaptureRef.current = new AudioCapture({
                onAudioData: (data) => {
                    if (geminiRef.current?.isActive()) {
                        geminiRef.current.sendAudio(data);
                    }
                },
                onError: (error) => {
                    showToast(getMicrophoneErrorMessage(error), 'error');
                },
                onStateChange: (state) => {
                    if (!conversationActiveRef.current) {
                        return;
                    }

                    if (state === 'muted') {
                        setIsListening(false);
                        if (settingsRef.current.conversationMode === 'push-to-talk') {
                            setStatusMessage('Hold to talk and speak.');
                        }
                    } else if (state === 'capturing') {
                        if (settingsRef.current.conversationMode === 'push-to-talk') {
                            setIsListening(pushToTalkPressedRef.current);
                        } else {
                            setIsListening(true);
                        }
                    }
                }
            });

            const captureStarted = await audioCaptureRef.current.start();
            if (!captureStarted) {
                stopInProgressRef.current = true;
                cleanupResources({ disconnectGemini: true });
                finishStoppedState(READY_STATUS_MESSAGE);
                stopInProgressRef.current = false;
                return;
            }

            audioPlaybackRef.current = new AudioPlayback({
                onStateChange: (state) => {
                    if (state === 'playing') {
                        setIsAiSpeaking(true);
                        setIsListening(false);
                        setStatusMessage('Noa is speaking...');
                    } else {
                        setIsAiSpeaking(false);
                        if (!conversationActiveRef.current) {
                            return;
                        }

                        if (settingsRef.current.conversationMode === 'push-to-talk') {
                            if (pushToTalkPressedRef.current) {
                                setIsListening(true);
                                setStatusMessage('Listening while held...');
                            } else {
                                setIsListening(false);
                                setStatusMessage('Hold to talk and speak.');
                            }
                        } else {
                            setIsListening(true);
                            setStatusMessage('Listening...');
                        }
                    }
                },
                onPlaybackEnd: () => {
                    if (!conversationActiveRef.current) {
                        return;
                    }

                    if (settingsRef.current.conversationMode === 'push-to-talk') {
                        if (pushToTalkPressedRef.current) {
                            setIsListening(true);
                            setStatusMessage('Listening while held...');
                        } else {
                            setIsListening(false);
                            setStatusMessage('Hold to talk and speak.');
                        }
                    } else {
                        setIsListening(true);
                        setStatusMessage('Listening...');
                    }
                }
            });

            geminiRef.current = new GeminiLive({
                systemInstruction: settings.systemInstruction,
                voiceName: settings.voiceName,
                conversationMode: settings.conversationMode,
                onConnected: () => {
                    if (stopInProgressRef.current) {
                        return;
                    }
                    setConnectionStatus('connected');
                    if (settingsRef.current.conversationMode === 'push-to-talk') {
                        setStatusMessage('Hold to talk and speak.');
                        setIsListening(false);
                    } else {
                        setStatusMessage('Listening...');
                        setIsListening(true);
                    }
                    showToast('Connected to Noa', 'success');
                },
                onDisconnected: () => {
                    if (stopInProgressRef.current || !conversationActiveRef.current) {
                        return;
                    }

                    stopInProgressRef.current = true;
                    persistCurrentConversation('connection-lost');
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
                    if (!conversationActiveRef.current) {
                        return;
                    }

                    if (settingsRef.current.conversationMode === 'push-to-talk') {
                        if (pushToTalkPressedRef.current) {
                            setIsListening(true);
                            setStatusMessage('Listening while held...');
                        } else {
                            setIsListening(false);
                            setStatusMessage('Hold to talk and speak.');
                        }
                    } else {
                        setIsListening(true);
                        setStatusMessage('Listening...');
                    }
                },
                onTranscript: (text, speaker) => {
                    addTranscriptEntry(text, speaker === 'user' ? 'user' : 'ai');
                },
                onError: (error) => {
                    console.error('Noa error:', error);
                    showToast(getErrorMessage(error), 'error');
                }
            });

            const connected = await geminiRef.current.connect();
            if (!connected) {
                throw new Error('Failed to connect to Noa');
            }

            if (settingsRef.current.conversationMode === 'push-to-talk') {
                audioCaptureRef.current.setMuted(true);
                setIsMuted(true);
                setIsListening(false);
                setStatusMessage('Hold to talk and speak.');
            } else {
                setStatusMessage('Listening...');
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
        persistCurrentConversation,
        settings.conversationMode,
        settings.systemInstruction,
        settings.voiceName,
        showToast
    ]);

    const handlePushToTalkDown = useCallback((event) => {
        event.preventDefault();
        if (!isConversationActive || settings.conversationMode !== 'push-to-talk') {
            return;
        }
        if (!audioCaptureRef.current || pushToTalkPressedRef.current) {
            return;
        }

        pushToTalkPressedRef.current = true;
        setIsPushToTalkPressed(true);
        audioCaptureRef.current.setMuted(false);
        setIsMuted(false);
        setIsListening(true);
        setStatusMessage('Listening while held...');
    }, [isConversationActive, settings.conversationMode]);

    const handlePushToTalkUp = useCallback((event) => {
        if (event) {
            event.preventDefault();
        }
        if (!audioCaptureRef.current || !pushToTalkPressedRef.current) {
            return;
        }

        pushToTalkPressedRef.current = false;
        setIsPushToTalkPressed(false);
        audioCaptureRef.current.setMuted(true);
        setIsMuted(true);
        setIsListening(false);

        if (conversationActiveRef.current) {
            setStatusMessage(isAiSpeaking ? 'Noa is speaking...' : 'Hold to talk and speak.');
        }
    }, [isAiSpeaking]);

    const toggleMute = useCallback(() => {
        if (!audioCaptureRef.current) {
            return;
        }

        if (settings.conversationMode === 'push-to-talk') {
            showToast('Push-to-talk mode is active. Use the Hold to Talk button.', 'info');
            return;
        }

        const muted = audioCaptureRef.current.toggleMute();
        setIsMuted(muted);
        showToast(muted ? 'Microphone muted' : 'Microphone unmuted', 'info');
    }, [settings.conversationMode, showToast]);

    const clearTranscript = useCallback(() => {
        setTranscripts([]);
    }, []);

    const exportConversationHistoryAsJson = useCallback(() => {
        if (conversationHistory.length === 0) {
            showToast('No conversation history to export.', 'warning');
            return;
        }

        downloadFile(
            `noa-live-history-${Date.now()}.json`,
            JSON.stringify(conversationHistory, null, 2),
            'application/json'
        );
        showToast('History exported as JSON.', 'success');
    }, [conversationHistory, showToast]);

    const exportConversationHistoryAsText = useCallback(() => {
        if (conversationHistory.length === 0) {
            showToast('No conversation history to export.', 'warning');
            return;
        }

        downloadFile(
            `noa-live-history-${Date.now()}.txt`,
            buildHistoryText(conversationHistory),
            'text/plain'
        );
        showToast('History exported as text.', 'success');
    }, [conversationHistory, showToast]);

    const clearConversationHistory = useCallback(() => {
        const confirmed = window.confirm('Clear all saved conversation history?');
        if (!confirmed) {
            return;
        }

        setConversationHistory([]);
        showToast('Conversation history cleared.', 'info');
    }, [showToast]);

    const saveSettings = useCallback(() => {
        const nextSettings = {
            systemInstruction: tempSettings.systemInstruction.trim() || DEFAULT_SYSTEM_INSTRUCTION,
            voiceName: normalizeVoiceName(tempSettings.voiceName),
            conversationMode: normalizeConversationMode(tempSettings.conversationMode)
        };

        setSettings(nextSettings);
        setTempSettings(nextSettings);

        try {
            localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
        } catch (error) {
            console.error('Failed to save settings:', error);
        }

        setIsSettingsOpen(false);
        if (isConversationActive) {
            showToast('Settings saved. Restart the call to apply new mode and voice.', 'info');
        } else {
            showToast('Settings saved', 'success');
        }
    }, [isConversationActive, showToast, tempSettings]);

    const isBusy = connectionStatus === 'connecting' || connectionStatus === 'disconnecting';
    const isPushToTalkMode = settings.conversationMode === 'push-to-talk';
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
                : 'Talk to Noa';

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
                        <h1>Noa Live</h1>
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
                        <h2>Noa</h2>
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
                                            {entry.speaker === 'user' ? 'You' : 'Noa'}
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
                        onClick={isConversationActive ? () => stopConversation() : startConversation}
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

                    {isPushToTalkMode && (
                        <button
                            className={`ptt-btn ${isPushToTalkPressed ? 'active' : ''}`}
                            disabled={!isConversationActive || isBusy}
                            onPointerDown={handlePushToTalkDown}
                            onPointerUp={handlePushToTalkUp}
                            onPointerCancel={handlePushToTalkUp}
                            onPointerLeave={() => {
                                if (isPushToTalkPressed) {
                                    handlePushToTalkUp();
                                }
                            }}
                            onKeyDown={(event) => {
                                if ((event.key === ' ' || event.key === 'Enter') && !isPushToTalkPressed) {
                                    handlePushToTalkDown(event);
                                }
                            }}
                            onKeyUp={(event) => {
                                if (event.key === ' ' || event.key === 'Enter') {
                                    handlePushToTalkUp(event);
                                }
                            }}
                            aria-pressed={isPushToTalkPressed}
                        >
                            {isPushToTalkPressed ? 'Release to Stop' : 'Hold to Talk'}
                        </button>
                    )}

                    <div className="secondary-controls">
                        <button
                            className={`control-btn ${isMuted ? 'muted' : ''}`}
                            onClick={toggleMute}
                            title={isPushToTalkMode ? 'Push-to-talk controls microphone state' : 'Mute microphone'}
                            aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                            aria-pressed={isMuted}
                            disabled={!isConversationActive || isPushToTalkMode}
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
                                Vercel token endpoint enabled. API key stays server-side.
                            </p>
                        </div>

                        <div className="form-group">
                            <label htmlFor="voiceName">Voice</label>
                            <select
                                id="voiceName"
                                value={tempSettings.voiceName}
                                onChange={event => setTempSettings({ ...tempSettings, voiceName: event.target.value })}
                            >
                                {VOICE_OPTIONS.map((voice) => (
                                    <option key={voice.value} value={voice.value}>
                                        {voice.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="form-group">
                            <label htmlFor="conversationMode">Conversation Mode</label>
                            <select
                                id="conversationMode"
                                value={tempSettings.conversationMode}
                                onChange={event => setTempSettings({
                                    ...tempSettings,
                                    conversationMode: normalizeConversationMode(event.target.value)
                                })}
                            >
                                <option value="vad">VAD (Hands-Free)</option>
                                <option value="push-to-talk">Push-to-Talk</option>
                            </select>
                            <p className="helper-text">
                                Use VAD for always-listening flow, or Push-to-Talk for explicit mic control.
                            </p>
                        </div>

                        <div className="form-group">
                            <label htmlFor="systemInstruction">Noa&apos;s Personality</label>
                            <textarea
                                id="systemInstruction"
                                rows="4"
                                placeholder="Describe how Noa should behave..."
                                value={tempSettings.systemInstruction}
                                onChange={e => setTempSettings({ ...tempSettings, systemInstruction: e.target.value })}
                            />
                            <p className="helper-text">
                                Customize how Noa responds and interacts with you.
                            </p>
                        </div>

                        <div className="form-group">
                            <label>Conversation History ({conversationHistory.length})</label>
                            <div className="history-actions">
                                <button className="btn btn-secondary" onClick={exportConversationHistoryAsJson} disabled={conversationHistory.length === 0}>
                                    Export JSON
                                </button>
                                <button className="btn btn-secondary" onClick={exportConversationHistoryAsText} disabled={conversationHistory.length === 0}>
                                    Export Text
                                </button>
                                <button className="btn btn-secondary" onClick={clearConversationHistory} disabled={conversationHistory.length === 0}>
                                    Clear
                                </button>
                            </div>
                            <div className="history-list">
                                {conversationHistory.length === 0 ? (
                                    <p className="helper-text">No saved conversations yet.</p>
                                ) : (
                                    conversationHistory.slice(0, 4).map(item => (
                                        <div key={item.id} className="history-item">
                                            <span>{formatTimestamp(item.startedAt)}</span>
                                            <span className="history-item-meta">
                                                {item.voiceName || DEFAULT_VOICE_NAME} / {item.conversationMode || DEFAULT_MODE} / {item.transcript?.length || 0} lines
                                            </span>
                                        </div>
                                    ))
                                )}
                            </div>
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
