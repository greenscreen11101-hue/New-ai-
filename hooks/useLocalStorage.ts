import { useState, useEffect, useCallback } from 'react';

// ✅ NEW: Browser detection helper
const isBrowser = (): boolean => {
    return typeof window !== 'undefined' && !!window.localStorage;
};

function getValue<T>(key: string, initialValue: T | (() => T)): T {
    // ✅ SSR safety: Return initial value if not in browser
    if (!isBrowser()) {
        return initialValue instanceof Function ? initialValue() : initialValue;
    }
    
    try {
        const savedValue = window.localStorage.getItem(key);
        if (savedValue) {
            try {
                return JSON.parse(savedValue);
            } catch (error) {
                console.error(`Error parsing localStorage key "${key}":`, error);
                return initialValue instanceof Function ? initialValue() : initialValue;
            }
        }
    } catch (e) {
        console.error(`Error reading localStorage key "${key}":`, e);
    }

    if (initialValue instanceof Function) {
        return initialValue();
    }
    return initialValue;
}

export function useLocalStorage<T>(
    key: string, 
    initialValue: T | (() => T)
): [T, React.Dispatch<React.SetStateAction<T>>] {
    const [value, setValue] = useState<T>(() => {
        return getValue(key, initialValue);
    });

    // ✅ NEW: Safe setter with quota handling
    const safeSetValue: React.Dispatch<React.SetStateAction<T>> = useCallback((newValueOrFn) => {
        setValue(prev => {
            const newValue = newValueOrFn instanceof Function 
                ? newValueOrFn(prev) 
                : newValueOrFn;
            
            if (!isBrowser()) return newValue;
            
            try {
                const serialized = JSON.stringify(newValue);
                
                // ✅ Check quota before saving
                if (serialized.length > 4.5 * 1024 * 1024) { // 4.5MB warning
                    console.warn(`LocalStorage item "${key}" is large (${(serialized.length / 1024 / 1024).toFixed(2)}MB). May exceed quota.`);
                }
                
                window.localStorage.setItem(key, serialized);
            } catch (e: any) {
                if (e.name === 'QuotaExceededError') {
                    console.error(`LocalStorage quota exceeded for key "${key}"`);
                    alert('Storage is full! Please clear some data in Settings.');
                } else {
                    console.error(`Error saving to localStorage key "${key}":`, e);
                }
            }
            
            return newValue;
        });
    }, [key]);

    return [value, safeSetValue];
}
