import type { ChatSession, Message } from '../types';

const SESSION_STORAGE_KEY = 'ahmad_ai_chat_sessions';
const MAX_SESSIONS = 50; // ✅ Limit sessions to prevent quota issues

/**
 * Generates a default title based on the first message
 */
const generateTitle = (messages: Message[]): string => {
    if (messages.length === 0) return 'New Conversation';
    
    const firstUserMsg = messages.find(m => m.sender === 'user');
    const cleanText = firstUserMsg?.text?.trim();
    
    if (!cleanText) return 'New Conversation';
    
    // ✅ Better truncation with word boundary
    if (cleanText.length <= 30) return cleanText;
    
    const truncated = cleanText.slice(0, 30);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '...';
};

export const getSessions = (): ChatSession[] => {
    try {
        const stored = localStorage.getItem(SESSION_STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (error) {
        console.error("Failed to load sessions:", error);
        return [];
    }
};

const saveSessions = (sessions: ChatSession[]) => {
    try {
        // ✅ Enforce max limit, keep most recent
        const trimmed = sessions.length > MAX_SESSIONS 
            ? sessions.slice(0, MAX_SESSIONS) 
            : sessions;
            
        const serialized = JSON.stringify(trimmed);
        
        if (serialized.length > 4 * 1024 * 1024) {
            console.warn('Session storage large, trimming...');
            const reduced = sessions.slice(0, 30);
            localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(reduced));
        } else {
            localStorage.setItem(SESSION_STORAGE_KEY, serialized);
        }
    } catch (e: any) {
        if (e.name === 'QuotaExceededError') {
            console.error('Session quota exceeded! Keeping only recent 20.');
            const emergency = sessions.slice(0, 20);
            try {
                localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(emergency));
            } catch (e2) {
                console.error('Critical: Cannot save sessions');
            }
        } else {
            console.error("Failed to save sessions:", e);
        }
    }
};

export const saveSession = (id: string, messages: Message[], title?: string) => {
    const sessions = getSessions();
    const existingIndex = sessions.findIndex(s => s.id === id);
    
    const now = new Date().toISOString();
    const sessionTitle = title || (existingIndex >= 0 ? sessions[existingIndex].title : generateTitle(messages));

    const newSession: ChatSession = {
        id,
        title: sessionTitle,
        messages,
        createdAt: existingIndex >= 0 ? sessions[existingIndex].createdAt : now,
        lastModified: now,
    };

    if (existingIndex >= 0) {
        sessions[existingIndex] = newSession;
    } else {
        sessions.push(newSession);
    }

    // Sort by last modified (newest first)
    sessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    
    saveSessions(sessions);
};

export const deleteSession = (id: string) => {
    const sessions = getSessions();
    const updated = sessions.filter(s => s.id !== id);
    saveSessions(updated);
};

export const getSessionById = (id: string): ChatSession | undefined => {
    const sessions = getSessions();
    return sessions.find(s => s.id === id);
};

export const createNewSessionId = (): string => {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};
