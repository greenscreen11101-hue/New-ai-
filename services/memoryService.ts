import type { Memory } from '../types';

const MEMORY_STORAGE_KEY = 'ahmad_ai_long_term_memory';
const MAX_MEMORIES = 200; // ✅ Limit to prevent quota issues

/**
 * Retrieves all stored memories.
 */
export const getMemories = (): Memory[] => {
    try {
        const stored = localStorage.getItem(MEMORY_STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error("Failed to load memories", e);
        return [];
    }
};

/**
 * Saves the entire memory bank with quota protection.
 */
const saveMemories = (memories: Memory[]) => {
    try {
        // ✅ Enforce max limit
        const trimmedMemories = memories.length > MAX_MEMORIES 
            ? memories.slice(-MAX_MEMORIES) 
            : memories;
            
        const serialized = JSON.stringify(trimmedMemories);
        
        // ✅ Check size before saving
        if (serialized.length > 4 * 1024 * 1024) { // 4MB
            console.warn('Memory storage too large, trimming oldest memories');
            const reduced = trimmedMemories.slice(-100);
            localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(reduced));
        } else {
            localStorage.setItem(MEMORY_STORAGE_KEY, serialized);
        }
    } catch (e: any) {
        if (e.name === 'QuotaExceededError') {
            console.error('Memory quota exceeded! Removing oldest memories.');
            // Emergency: Keep only last 50
            const emergency = memories.slice(-50);
            try {
                localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(emergency));
            } catch (e2) {
                console.error('Critical: Cannot save even 50 memories');
            }
        } else {
            console.error("Failed to save memories", e);
        }
    }
};

/**
 * Adds a single memory to the store.
 */
export const addMemory = (memory: Memory) => {
    const existing = getMemories();
    const updated = [...existing, memory];
    saveMemories(updated);
};

/**
 * Deletes a specific memory by ID.
 */
export const deleteMemory = (id: string) => {
    const memories = getMemories();
    const updated = memories.filter(m => m.id !== id);
    saveMemories(updated);
};

/**
 * Pure logic fallback for offline search.
 * Does not depend on any AI service.
 */
export const offlineMemorySearch = (query: string, memories: Memory[]): string[] => {
    if (!query.trim()) return [];
    
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3); 
    if (keywords.length === 0) return [];

    const scoredMemories = memories.map(mem => {
        let score = 0;
        const textToSearch = `${mem.title} ${mem.tags.join(' ')} ${mem.content}`.toLowerCase();
        
        keywords.forEach(word => {
            if (textToSearch.includes(word)) score += 1;
            if (mem.title.toLowerCase().includes(word)) score += 2;
            if (mem.tags.some(t => t.toLowerCase().includes(word))) score += 2; 
        });

        return { mem, score };
    });

    return scoredMemories
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(item => `[Memory (Offline Match): ${item.mem.title} (${item.mem.timestamp})]\n${item.mem.content}`);
};
