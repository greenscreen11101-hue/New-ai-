
export type Sender = 'user' | 'ai';

export interface Message {
  id: number;
  text: string;
  sender: Sender;
  attachments?: {
    name: string;
    type: string;
  }[];
  type?: 'message' | 'separator';
  rating?: 'up' | 'down';
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  lastModified: string;
  summary?: string;
}

export interface Skill {
  name: string;
  description: string;
  code: string;
  timestamp: string;
}

export interface TaughtSkill {
  id: string;
  name: string;
  commandExample: string;
  outcome: string;
  parameters: string[];
  timestamp: string;
}

export interface Memory {
  id: string;
  title: string;
  content: string;
  tags: string[];
  timestamp: string;
  importance: number; // 1-10 scale
}

export type Theme = 'light' | 'dark';

export type View = 'chat' | 'settings' | 'upgrades' | 'teach' | 'memory' | 'history';

// UPDATED: Added 'auto' and 'custom' providers
export type AIProvider = 'auto' | 'gemini' | 'openrouter' | 'huggingface' | 'hybrid' | 'custom';

export interface AISettings {
  provider: AIProvider;
  openRouterApiKeys: string[];
  openRouterKeyIndex: number;
  huggingFaceApiKeys: string[];
  huggingFaceKeyIndex: number;
  // NEW: Custom Endpoint Settings
  customBaseUrl: string;
  customApiKey: string;
  customModelName: string;
  isComplexTaskMode: boolean;
  // NEW: Global User Bio/Instructions
  userBio: string;
}

export interface OpenRouterRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

export interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export interface ExecutionPlan {
  skillName: string;
  code: string;
  args: any[];
}

export type OfflineCache = Record<string, string>;
