import { GoogleGenAI } from "@google/genai";
import type { Message, Skill, TaughtSkill, AISettings, ExecutionPlan, OfflineCache, Memory, ChatSession } from '../types';
import { getMemories, addMemory, offlineMemorySearch } from './memoryService';

// ✅ FIXED: Proper API key validation
const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;

if (!apiKey || apiKey === 'MISSING_KEY' || apiKey.length < 10) {
    console.error('❌ GEMINI_API_KEY is missing or invalid!');
    console.error('Please create .env.local file with: GEMINI_API_KEY=your_actual_key_here');
}

// Initialize with fallback for build-time
const ai = new GoogleGenAI({ apiKey: apiKey || 'dummy-key-for-build' });

// --- DYNAMIC CACHE ---
let cachedOpenRouterModels: string[] = [];
let cachedHuggingFaceModels: string[] = [];
let lastDiscoveryTime = 0;
const CACHE_DURATION = 1000 * 60 * 60; 

// --- SAFETY FALLBACKS ---
const SAFETY_FALLBACK_OPENROUTER = [
    'deepseek/deepseek-r1:free',
    'google/gemini-2.0-flash-lite-preview-02-05:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
    'microsoft/phi-3-medium-128k-instruct:free',
];

const SAFETY_FALLBACK_HF = [
    "HuggingFaceH4/zephyr-7b-beta",
    "mistralai/Mistral-7B-Instruct-v0.3"
];

// --- HELPER FUNCTIONS ---

const getOpenRouterKeys = (settings: AISettings): string[] => {
    if (!settings.openRouterApiKeys || settings.openRouterApiKeys.length === 0) return [];
    return settings.openRouterApiKeys;
}

const getHuggingFaceKeys = (settings: AISettings): string[] => {
    if (!settings.huggingFaceApiKeys || settings.huggingFaceApiKeys.length === 0) return [];
    return settings.huggingFaceApiKeys;
}

const sanitizeAndParseJson = (text: string): any => {
    try { return JSON.parse(text); } catch (e) {}

    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
        try { return JSON.parse(codeBlockMatch[1]); } catch (e) {}
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
         try { return JSON.parse(text.substring(firstBrace, lastBrace + 1)); } catch (e) {}
    }
    
    const startArr = text.indexOf('[');
    const endArr = text.lastIndexOf(']');
    if (startArr !== -1 && endArr !== -1 && endArr > startArr) {
        try { return JSON.parse(text.substring(startArr, endArr + 1)); } catch (e) {}
    }
    
    const cleanText = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
    try { return JSON.parse(cleanText); } catch(e) {}

    throw new Error("Could not parse valid JSON from the AI response.");
}

// ✅ NEW: Timeout helper for fetch
const fetchWithTimeout = async (
    url: string, 
    options: RequestInit = {}, 
    timeout = 10000
): Promise<Response> => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error: any) {
        clearTimeout(id);
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeout}ms`);
        }
        throw error;
    }
};

// --- DYNAMIC DISCOVERY ENGINES ---

const discoverFreeOpenRouterModels = async (): Promise<string[]> => {
    try {
        const response = await fetchWithTimeout("https://openrouter.ai/api/v1/models", {}, 15000);
        const data = await response.json();
        if (!data.data) throw new Error("Invalid OpenRouter response");

        const freeModels = data.data.filter((model: any) => {
            const promptPrice = parseFloat(model.pricing?.prompt || "1");
            const completionPrice = parseFloat(model.pricing?.completion || "1");
            return promptPrice === 0 && completionPrice === 0;
        });

        const sortedModels = freeModels.sort((a: any, b: any) => {
            const getScore = (m: any) => {
                let score = 0;
                const id = m.id.toLowerCase();
                if (id.includes('deepseek-r1')) score += 15; 
                if (id.includes('llama-3')) score += 10;
                if (id.includes('mistral')) score += 8;
                if (id.includes('gemini')) score += 8;
                if (id.includes('free')) score += 1;
                return score;
            };
            return getScore(b) - getScore(a);
        });

        const modelIds = sortedModels.map((m: any) => m.id);
        return modelIds.length > 0 ? modelIds : SAFETY_FALLBACK_OPENROUTER;
    } catch (error) {
        console.warn('OpenRouter discovery failed:', error);
        return SAFETY_FALLBACK_OPENROUTER;
    }
};

const discoverTrendingHFModels = async (): Promise<string[]> => {
    try {
        const response = await fetchWithTimeout(
            "https://huggingface.co/api/models?pipeline_tag=text-generation&sort=downloads&direction=-1&limit=20", 
            {}, 
            15000
        );
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error("Invalid HF response");
        const filtered = data.filter((model: any) => !model.modelId.toLowerCase().includes("gemma-7b"));
        const modelIds = filtered.map((m: any) => m.modelId);
        return [...new Set([...SAFETY_FALLBACK_HF, ...modelIds])];
    } catch (error) {
        console.warn('HuggingFace discovery failed:', error);
        return SAFETY_FALLBACK_HF;
    }
};

const refreshModelCache = async () => {
    const now = Date.now();
    if (now - lastDiscoveryTime > CACHE_DURATION || cachedOpenRouterModels.length === 0) {
        const [orModels, hfModels] = await Promise.all([
            discoverFreeOpenRouterModels(),
            discoverTrendingHFModels()
        ]);
        cachedOpenRouterModels = orModels;
        cachedHuggingFaceModels = hfModels;
        lastDiscoveryTime = now;
    }
};

// --- CORE PROVIDER IMPLEMENTATIONS ---

const callGemini = async (model: string, contents: any[], config: any, onChunk?: (chunk: string) => void): Promise<{ text: string }> => {
    if (onChunk) {
        const stream = await ai.models.generateContentStream({ model, contents, config });
        let fullResponse = '';
        for await (const chunk of stream) {
            const text = chunk.text;
            if (text) {
                onChunk(text);
                fullResponse += text;
            }
        }
        return { text: fullResponse };
    } else {
        const response = await ai.models.generateContent({ model, contents, config });
        let groundingText = "";
        if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
            const chunks = response.candidates[0].groundingMetadata.groundingChunks;
            const sources = chunks.filter((c: any) => c.web?.uri).map((c: any) => `[${c.web.title}](${c.web.uri})`);
            if (sources.length > 0) groundingText = `\n\n**Sources:**\n${[...new Set(sources)].join('\n')}`;
        }
        return { text: (response.text || '') + groundingText };
    }
};

const callOpenRouter = async (messages: any[], apiKeys: string[], onChunk?: (chunk: string) => void, specificModel?: string): Promise<{ text: string }> => {
    if (cachedOpenRouterModels.length === 0) await refreshModelCache();
    let modelsToTry = specificModel ? [specificModel] : [...cachedOpenRouterModels];
    let lastError;

    for (const modelName of modelsToTry) {
        for (const apiKey of apiKeys) {
            try {
                const response = await fetchWithTimeout(
                    "https://openrouter.ai/api/v1/chat/completions",
                    {
                        method: "POST",
                        headers: { 
                            "Authorization": `Bearer ${apiKey}`, 
                            "Content-Type": "application/json", 
                            "HTTP-Referer": "https://aistudio.google.com", 
                            "X-Title": "Ahmad AI" 
                        },
                        body: JSON.stringify({ model: modelName, messages: messages, stream: !!onChunk })
                    },
                    30000 // 30s timeout for chat
                );

                if (!response.ok) {
                    if ([401, 402, 429].includes(response.status)) continue;
                    break;
                }

                if (onChunk && response.body) {
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let fullResponse = '';
                    let buffer = '';
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const dataStr = line.substring(6);
                                if (dataStr.trim() === '[DONE]') continue;
                                try {
                                    const data = JSON.parse(dataStr);
                                    const chunk = data.choices[0]?.delta?.content;
                                    if (chunk) { onChunk(chunk); fullResponse += chunk; }
                                } catch (e) {}
                            }
                        }
                    }
                    return { text: fullResponse };
                } else {
                    const data = await response.json();
                    return { text: data.choices[0].message.content };
                }
            } catch (error) {
                lastError = error;
                continue;
            }
        }
    }
    throw new Error(`OpenRouter failed. Last error: ${lastError}`);
};

const callCustomEndpoint = async (
    settings: AISettings,
    messages: any[],
    onChunk?: (chunk: string) => void
): Promise<{ text: string }> => {
    const baseUrl = settings.customBaseUrl.replace(/\/$/, "");
    const url = `${baseUrl}/chat/completions`;
    const apiKey = settings.customApiKey || "dummy-key";
    const model = settings.customModelName || "default";

    try {
        const response = await fetchWithTimeout(
            url,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    stream: !!onChunk
                })
            },
            30000
        );

        if (!response.ok) throw new Error(`Custom API Error: ${response.status} ${response.statusText}`);

        if (onChunk && response.body) {
             const reader = response.body.getReader();
             const decoder = new TextDecoder();
             let fullResponse = '';
             let buffer = '';
             while (true) {
                 const { done, value } = await reader.read();
                 if (done) break;
                 buffer += decoder.decode(value, { stream: true });
                 const lines = buffer.split('\n');
                 buffer = lines.pop() || '';
                 for (const line of lines) {
                     if (line.startsWith('data: ')) {
                         const dataStr = line.substring(6);
                         if (dataStr.trim() === '[DONE]') continue;
                         try {
                             const data = JSON.parse(dataStr);
                             const chunk = data.choices[0]?.delta?.content;
                             if (chunk) { onChunk(chunk); fullResponse += chunk; }
                         } catch (e) {}
                     }
                 }
             }
             return { text: fullResponse };
        } else {
            const data = await response.json();
            return { text: data.choices[0]?.message?.content || "" };
        }
    } catch (error) {
        throw new Error(`Custom Provider Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
};

const callHuggingFace = async (prompt: string, apiKeys: string[], systemInstruction?: string): Promise<{ text: string }> => {
    if (cachedHuggingFaceModels.length === 0) await refreshModelCache();
    const fullPrompt = systemInstruction ? `<|system|>\n${systemInstruction}</s>\n<|user|>\n${prompt}</s>\n<|assistant|>` : `<|user|>\n${prompt}</s>\n<|assistant|>`;
    let lastError;

    for (const model of cachedHuggingFaceModels) {
        for (const apiKey of apiKeys) {
            try {
                const response = await fetchWithTimeout(
                    `https://api-inference.huggingface.co/models/${model}`,
                    {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ 
                            inputs: fullPrompt, 
                            parameters: { max_new_tokens: 1024, temperature: 0.7, return_full_text: false } 
                        })
                    },
                    45000 // 45s for HF (slower)
                );

                if (!response.ok) continue;
                const data = await response.json();
                if (data.error && data.error.includes("loading")) throw new Error("Model loading");
                
                let generatedText = Array.isArray(data) ? data[0].generated_text : (data.generated_text || "");
                if (typeof data === 'string') generatedText = data;
                if (!generatedText) throw new Error("Empty response");
                return { text: generatedText };
            } catch (error) {
                lastError = error;
            }
        }
    }
    throw new Error(`Hugging Face failed. Last error: ${lastError}`);
};

// ✅ FIXED: Moved getMultiModelResponse BEFORE executeWithFallback
export const getMultiModelResponse = async (
    prompt: string, 
    history: Message[], 
    settings: AISettings, 
    onChunk: (chunk: string) => void
): Promise<{ text: string }> => {
    const promises: Promise<{ text: string, source: string } | null>[] = [];
    
    promises.push(
        callGemini('gemini-2.5-pro', [{role:'user', parts:[{text: prompt}]}], {})
            .then(res => ({ text: res.text, source: 'Gemini' }))
            .catch(err => {
                console.warn('Gemini hybrid call failed:', err);
                return null;
            })
    );
    
    if (getOpenRouterKeys(settings).length > 0) {
        promises.push(
            callOpenRouter([{role:'user', content: prompt}], getOpenRouterKeys(settings))
                .then(res => ({ text: res.text, source: 'OpenRouter' }))
                .catch(err => {
                    console.warn('OpenRouter hybrid call failed:', err);
                    return null;
                })
        );
    }
    
    const results = await Promise.all(promises);
    const valid = results.filter(r => r !== null) as { text: string, source: string }[];
    
    if (valid.length === 0) {
        return executeWithFallback({ prompt, history, settings, systemInstruction: "You are a helpful AI assistant." });
    }

    const synthesisPrompt = `Synthesize the following AI responses into one coherent answer. Choose the best parts from each:\n\n${valid.map(r => `--- ${r.source} ---\n${r.text}`).join('\n\n')}\n\nProvide a unified response:`;
    
    return executeWithFallback({ 
        prompt: synthesisPrompt, 
        history: [], 
        settings, 
        systemInstruction: "You are a synthesis engine. Combine multiple AI responses into one coherent answer." 
    });
};

export const executeWithFallback = async (params: {
    prompt: string,
    history: Message[],
    settings: AISettings,
    systemInstruction?: string,
    jsonMode?: boolean,
    files?: { mimeType: string; data: string }[],
    useTools?: boolean, 
    onChunk?: (chunk: string) => void
}): Promise<{ text: string }> => {
    const { prompt, history, settings, systemInstruction, jsonMode, files = [], useTools, onChunk } = params;
    
    refreshModelCache().catch(console.error);

    let providers: string[] = [];
    
    if (settings.provider === 'auto') {
        if (settings.customBaseUrl) providers.push('custom');
        providers.push('gemini');
        if (getOpenRouterKeys(settings).length > 0) providers.push('openrouter');
        if (getHuggingFaceKeys(settings).length > 0) providers.push('huggingface');
    } else {
        providers.push(settings.provider);
        if (settings.provider !== 'gemini') providers.push('gemini'); 
        if (settings.provider !== 'custom' && settings.customBaseUrl) providers.push('custom');
    }
    
    providers = [...new Set(providers)];

    let lastError: any = null;

    for (const currentProvider of providers) {
        try {
            if (currentProvider === 'hybrid') {
                return await getMultiModelResponse(prompt, history, settings, onChunk || (() => {}));
            }

            if (currentProvider === 'custom') {
                const messages = [
                    { role: 'system', content: systemInstruction || "You are a helpful AI assistant." },
                    ...history.map(msg => ({ role: msg.sender === 'user' ? 'user' : 'assistant', content: msg.text })),
                    { role: 'user', content: prompt }
                ];
                if (jsonMode) messages[messages.length - 1].content += "\n\nResponse must be valid JSON.";
                return await callCustomEndpoint(settings, messages, onChunk);
            }

            if (currentProvider === 'gemini') {
                let model = 'gemini-2.5-flash'; 
                const config: any = { systemInstruction };
                if (settings.isComplexTaskMode) { 
                    model = 'gemini-3-pro-preview'; 
                    config.thinkingConfig = { thinkingBudget: 32768 }; 
                }
                else if (files.length > 0) { model = 'gemini-2.5-flash'; }
                if (jsonMode) config.responseMimeType = "application/json";
                if (useTools && !jsonMode) config.tools = [{ googleSearch: {} }];

                const userParts: any[] = [{ text: prompt }];
                files.forEach(f => userParts.push({ inlineData: { mimeType: f.mimeType, data: f.data } }));
                
                const contents = [
                    ...history.map(msg => ({ role: msg.sender === 'user' ? 'user' : 'model', parts: [{ text: msg.text }] })),
                    { role: 'user', parts: userParts }
                ];
                return await callGemini(model, contents, config, onChunk);
            }

            if (currentProvider === 'openrouter') {
                const apiKeys = getOpenRouterKeys(settings);
                if (apiKeys.length === 0) throw new Error("No OpenRouter Keys");
                const messages = [
                    { role: 'system', content: systemInstruction || "You are a helpful AI assistant." },
                    ...history.map(msg => ({ role: msg.sender === 'user' ? 'user' : 'assistant', content: msg.text })),
                    { role: 'user', content: prompt }
                ];
                if (jsonMode) messages[messages.length - 1].content += "\n\nRespond with valid JSON only.";
                return await callOpenRouter(messages, apiKeys, onChunk, undefined);
            }

            if (currentProvider === 'huggingface') {
                const apiKeys = getHuggingFaceKeys(settings);
                if (apiKeys.length === 0) throw new Error("No Hugging Face Keys");
                const promptWithContext = history.map(m => `${m.sender}: ${m.text}`).join('\n') + `\nUser: ${prompt}`;
                return await callHuggingFace(jsonMode ? `${promptWithContext}\nJSON:` : promptWithContext, apiKeys, systemInstruction);
            }

        } catch (error) {
            console.warn(`${currentProvider} failed:`, error);
            lastError = error;
        }
    }

    throw new Error(`All available AI providers failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

// ... rest of exports remain the same
export const analyzeUrlContent = async (url: string, settings: AISettings): Promise<string> => {
    const systemInstruction = `You are a Web Content Analyst. Summarize the page content concisely.`;
    const prompt = `Analyze this URL: ${url}`;
    const response = await executeWithFallback({ prompt, history: [], settings, systemInstruction, useTools: true });
    return response.text;
};

export const performDeepResearch = async (topic: string, settings: AISettings): Promise<string> => {
    const systemInstruction = `You are a Research Analyst. Provide a comprehensive report.`;
    const prompt = `Research on: "${topic}"`;
    const response = await executeWithFallback({ prompt, history: [], settings, systemInstruction, useTools: true });
    return response.text;
};

export const detectSessionSwitch = async (userPrompt: string, sessions: ChatSession[], settings: AISettings): Promise<string | null> => {
    if (sessions.length === 0) return null;
    const sessionSummaries = sessions.map(s => ({ id: s.id, title: s.title, lastMessage: s.messages[s.messages.length - 1]?.text?.slice(0, 50) }));
    const systemInstruction = `Session Manager. User Prompt: "${userPrompt}". Available: ${JSON.stringify(sessionSummaries)}. Return JSON { "switch": true, "sessionId": "..." } if user wants to switch context.`;
    try {
        const response = await executeWithFallback({ prompt: "Analyze intent.", history: [], settings, systemInstruction, jsonMode: true });
        const result = sanitizeAndParseJson(response.text);
        return (result.switch && result.sessionId) ? result.sessionId : null;
    } catch (e) { return null; }
};

export const getChatResponse = async (
    prompt: string, 
    history: Message[], 
    settings: AISettings, 
    files: { mimeType: string; data: string }[] = [], 
    onChunk?: (chunk: string) => void
): Promise<{ text: string }> => {
    let memoryContext = "";
    try {
        if (files.length === 0) {
            const memories = getMemories(); 
            const relevant = offlineMemorySearch(prompt, memories);
            if (relevant.length > 0) memoryContext = `\n\n[MEMORY]:\n${relevant.join('\n')}\n`;
        }
    } catch (e) {}

    const finalPrompt = memoryContext ? `${memoryContext}\n${prompt}` : prompt;
    const systemInstruction = "You are Ahmad AI, an expert software engineer and helpful personal assistant. Respond in Markdown.";
    return executeWithFallback({ prompt: finalPrompt, history, settings, systemInstruction, files, onChunk });
};

export const learnNewSkill = async (prompt: string, settings: AISettings): Promise<Skill> => {
    const systemInstruction = `Return JSON { "skillName": "", "description": "", "code": "" }.`;
    const response = await executeWithFallback({ prompt, history: [], settings, systemInstruction, jsonMode: true });
    const json = sanitizeAndParseJson(response.text);
    return { name: json.skillName, description: json.description, code: json.code, timestamp: new Date().toISOString() };
};

export const learnSkillFromUrl = async (promptWithUrl: string, settings: AISettings): Promise<Skill> => {
     const systemInstruction = `Extract skill from URL content. Return JSON { "skillName": "", "description": "", "code": "" }.`;
     const response = await executeWithFallback({ prompt: promptWithUrl, history: [], settings, systemInstruction, jsonMode: true });
     const json = sanitizeAndParseJson(response.text);
     return { name: json.skillName, description: json.description, code: json.code, timestamp: new Date().toISOString() };
};

export const initiateSelfUpgrade = async (skills: Skill[], taughtSkills: TaughtSkill[], settings: AISettings): Promise<Skill> => {
    const response = await executeWithFallback({ prompt: `Propose skill from: ${JSON.stringify(skills.map(s => s.name))}. Return "learn how to..."`, history: [], settings });
    return learnNewSkill(response.text, settings);
};

export const proposeSkillFromHistory = async (history: Message[], skills: Skill[], taughtSkills: TaughtSkill[], settings: AISettings): Promise<Skill | null> => {
    try {
        const response = await executeWithFallback({ prompt: `Suggest skill? Return "learn how to..." or "NO".\n${history.slice(-5).map(m => m.text).join('\n')}`, history: [], settings });
        if (response.text.includes("NO")) return null;
        return learnNewSkill(response.text, settings);
    } catch (e) { return null; }
};

export const findAndPrepareSkillExecution = async (prompt: string, skills: Skill[], settings: AISettings): Promise<ExecutionPlan | null> => {
    if (skills.length === 0) return null;
    try {
        const response = await executeWithFallback({ prompt: `Match skill: "${prompt}"\nSkills: ${JSON.stringify(skills.map(s => s.name))}\nReturn JSON { "match": true, "skillName": "", "args": [] }`, history: [], settings, jsonMode: true });
        const result = sanitizeAndParseJson(response.text);
        if (result.match) {
            const skill = skills.find(s => s.name === result.skillName);
            if (skill) return { skillName: skill.name, code: skill.code, args: result.args || [] };
        }
        return null;
    } catch (error) { return null; }
};

export const fixSkillCode = async (brokenCode: string, errorMessage: string, settings: AISettings): Promise<string> => {
    const systemInstruction = `Fix JS code. Return ONLY code.`;
    const prompt = `Error: "${errorMessage}"\nCode:\n${brokenCode}`;
    const response = await executeWithFallback({ prompt, history: [], settings, systemInstruction });
    return response.text.replace(/```(?:javascript|js)?|```/g, '').trim();
};

export const createMemoryFromChat = async (messages: Message[], settings: AISettings): Promise<Memory | null> => {
    if (messages.length < 3) return null;
    const response = await executeWithFallback({ prompt: `Analyze chat for memory. Return JSON { "worthy": boolean, "title": "", "content": "", "tags": [], "importance": 1 }.`, history: messages, settings, jsonMode: true });
    const result = sanitizeAndParseJson(response.text);
    if (!result.worthy) return null;
    const newMemory: Memory = { id: Date.now().toString(), title: result.title, content: result.content, tags: result.tags || [], importance: result.importance || 1, timestamp: new Date().toISOString() };
    addMemory(newMemory);
    return newMemory;
};

export const generateOfflineCache = async (history: Message[], settings: AISettings): Promise<OfflineCache | null> => {
    if (history.length < 2) return null;
    try {
        const response = await executeWithFallback({ prompt: `Summarize to JSON key-value.`, history, settings, jsonMode: true });
        return sanitizeAndParseJson(response.text);
    } catch (error) { return null; }
};

// ✅ NEW: Missing export that was referenced in App.tsx
export const saveExplicitMemory = async (content: string, settings: AISettings): Promise<void> => {
    const response = await executeWithFallback({ 
        prompt: `Analyze and structure this memory: "${content}". Return JSON { "title": "", "content": "", "tags": [], "importance": 1 }.`, 
        history: [], 
        settings, 
        jsonMode: true 
    });
    const result = sanitizeAndParseJson(response.text);
    const newMemory: Memory = { 
        id: Date.now().toString(), 
        title: result.title, 
        content: result.content, 
        tags: result.tags || [], 
        importance: result.importance || 1, 
        timestamp: new Date().toISOString() 
    };
    addMemory(newMemory);
};
