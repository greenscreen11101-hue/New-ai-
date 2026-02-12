import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from './components/Header';
import { ChatWindow } from './components/ChatWindow';
import { InputBar } from './components/InputBar';
import { SettingsScreen } from './components/SettingsScreen';
import { UpgradeCenter } from './components/UpgradeCenter';
import { useLocalStorage } from './hooks/useLocalStorage';
import { useUndoableLocalStorage } from './hooks/useUndoableLocalStorage';
import { 
  getChatResponse, 
  learnNewSkill, 
  learnSkillFromUrl, 
  initiateSelfUpgrade, 
  proposeSkillFromHistory, 
  findAndPrepareSkillExecution, 
  generateOfflineCache, 
  createMemoryFromChat,
  detectSessionSwitch,
  fixSkillCode,
  analyzeUrlContent,
  performDeepResearch,
  saveExplicitMemory
} from './services/geminiService';
import { executeSkillInSandbox } from './services/sandboxService';
import { saveSession, createNewSessionId, getSessions, getSessionById } from './services/sessionService';

import type { Message, Skill, TaughtSkill, Theme, View, AISettings, OfflineCache, ChatSession } from './types';
import { SkillConfirmationModal } from './components/SkillConfirmationModal';
import { TeachScreen } from './components/TeachScreen';
import { MemoryBank } from './components/MemoryBank';
import { ConfirmationModal } from './components/ConfirmationModal';
import { HistoryView } from './components/HistoryView';

/**
 * Converts a media File object to a base64 encoded string.
 */
const fileToBase64 = (file: File): Promise<{ mimeType: string, data: string, name: string }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      const base64Data = result.split(',')[1];
      if (base64Data) {
        resolve({
          mimeType: file.type || 'application/octet-stream',
          data: base64Data,
          name: file.name
        });
      } else {
        reject(new Error(`Failed to read file "${file.name}" as base64.`));
      }
    };
    reader.onerror = (error) => reject(error);
  });
};

/**
 * Reads any file as a plain text string.
 */
const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsText(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
};

/**
 * Main application component for Ahmad AI.
 */
const App: React.FC = () => {
  // --- STATE MANAGEMENT ---
  const [theme, setTheme] = useLocalStorage<Theme>('theme', 'dark');
  const [view, setView] = useState<View>('chat');
  
  // ✅ FIXED: Complete state declaration with proper initialization
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => {
    // Initialize with new session ID immediately
    return createNewSessionId();
  });
  
  const [messages, setMessages] = useUndoableLocalStorage<Message[]>(`chat-${currentSessionId}`, []);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState<Message | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [searchQuery, setSearchQuery] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  
  // AI Settings
  const [aiSettings, setAiSettings] = useLocalStorage<AISettings>('aiSettings', {
    provider: 'auto',
    openRouterApiKeys: [],
    openRouterKeyIndex: 0,
    huggingFaceApiKeys: [],
    huggingFaceKeyIndex: 0,
    customBaseUrl: '',
    customApiKey: '',
    customModelName: '',
    isComplexTaskMode: false,
    userBio: ''
  });

  // Skills & Memory
  const [skills, setSkills] = useLocalStorage<Skill[]>('learnedSkills', []);
  const [taughtSkills, setTaughtSkills] = useLocalStorage<TaughtSkill[]>('taughtSkills', []);
  const [pendingSkill, setPendingSkill] = useState<Skill | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- EFFECTS ---

  // Online/Offline detection
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Auto-save session
  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      saveSession(currentSessionId, messages);
    }
  }, [currentSessionId, messages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingMessage]);

  // --- HANDLERS ---

  const handleNewChat = useCallback(() => {
    const newSessionId = createNewSessionId();
    setCurrentSessionId(newSessionId);
    setMessages([]);
    setFiles([]);
    setView('chat');
  }, [setMessages]);

  const handleSendMessage = useCallback(async (text: string, uploadedFiles: File[]) => {
    if ((!text.trim() && uploadedFiles.length === 0) || isLoading) return;

    // Add user message
    const userMessage: Message = {
      id: Date.now(),
      text: text.trim(),
      sender: 'user',
      attachments: uploadedFiles.length > 0 ? uploadedFiles.map(f => ({ name: f.name, type: f.type })) : undefined
    };

    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    setStreamingMessage(null);

    try {
      // Process files if any
      let fileData: { mimeType: string; data: string }[] = [];
      if (uploadedFiles.length > 0) {
        fileData = await Promise.all(uploadedFiles.map(file => fileToBase64(file)));
      }

      // Check for skill execution
      const executionPlan = await findAndPrepareSkillExecution(text, skills, aiSettings);
      if (executionPlan) {
        try {
          const result = await executeSkillInSandbox(executionPlan.code, executionPlan.args);
          const aiResponse: Message = {
            id: Date.now() + 1,
            text: `**Executed Skill: ${executionPlan.skillName}**\n\nResult:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
            sender: 'ai'
          };
          setMessages(prev => [...prev, aiResponse]);
          setIsLoading(false);
          return;
        } catch (skillError) {
          console.error('Skill execution failed:', skillError);
          // Continue to normal AI response
        }
      }

      // Get AI response with streaming
      let streamedText = '';
      const onChunk = (chunk: string) => {
        streamedText += chunk;
        setStreamingMessage({
          id: Date.now() + 1,
          text: streamedText,
          sender: 'ai'
        });
      };

      const response = await getChatResponse(
        text,
        messages,
        aiSettings,
        fileData,
        onChunk
      );

      // Final message
      const finalAiMessage: Message = {
        id: Date.now() + 1,
        text: response.text,
        sender: 'ai'
      };

      setMessages(prev => [...prev, finalAiMessage]);
      setStreamingMessage(null);

      // Auto-create memory from important conversations
      if (messages.length > 5) {
        createMemoryFromChat([...messages, finalAiMessage], aiSettings).catch(console.error);
      }

    } catch (error) {
      console.error('Failed to get AI response:', error);
      const errorMessage: Message = {
        id: Date.now() + 1,
        text: `**Error:** ${error instanceof Error ? error.message : 'Failed to get response. Please check your AI settings.'}`,
        sender: 'ai'
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setStreamingMessage(null);
      setFiles([]);
    }
  }, [messages, isLoading, aiSettings, skills, setMessages]);

  const handleRegenerateResponse = useCallback(async () => {
    if (messages.length === 0) return;
    
    // Find last AI message
    const lastAiIndex = [...messages].reverse().findIndex(m => m.sender === 'ai');
    if (lastAiIndex === -1) return;
    
    const actualIndex = messages.length - 1 - lastAiIndex;
    const messagesUpToLastUser = messages.slice(0, actualIndex);
    
    // Remove last AI message and regenerate
    setMessages(messagesUpToLastUser);
    setIsLoading(true);

    try {
      const lastUserMessage = [...messagesUpToLastUser].reverse().find(m => m.sender === 'user');
      if (!lastUserMessage) {
        setIsLoading(false);
        return;
      }

      const response = await getChatResponse(
        lastUserMessage.text,
        messagesUpToLastUser.slice(0, -1),
        aiSettings
      );

      const regeneratedMessage: Message = {
        id: Date.now(),
        text: response.text,
        sender: 'ai'
      };

      setMessages(prev => [...prev, regeneratedMessage]);
    } catch (error) {
      console.error('Regeneration failed:', error);
    } finally {
      setIsLoading(false);
    }
  }, [messages, aiSettings, setMessages]);

  const handleDeleteMessage = useCallback((messageId: number) => {
    setMessages(prev => prev.filter(m => m.id !== messageId));
  }, [setMessages]);

  const handleRateMessage = useCallback((messageId: number, rating: 'up' | 'down') => {
    setMessages(prev => prev.map(m => 
      m.id === messageId ? { ...m, rating } : m
    ));
  }, [setMessages]);

  const handleSaveSkill = useCallback((skillData: Omit<TaughtSkill, 'id' | 'timestamp'>) => {
    const newSkill: TaughtSkill = {
      ...skillData,
      id: `skill-${Date.now()}`,
      timestamp: new Date().toISOString()
    };
    setTaughtSkills(prev => [...prev, newSkill]);
  }, [setTaughtSkills]);

  const handleConfirmSkill = useCallback(() => {
    if (pendingSkill) {
      setSkills(prev => [...prev, pendingSkill]);
      setPendingSkill(null);
    }
  }, [pendingSkill, setSkills]);

  const handleClearAllData = useCallback(() => {
    localStorage.clear();
    setSkills([]);
    setTaughtSkills([]);
    setMessages([]);
    setAiSettings({
      provider: 'auto',
      openRouterApiKeys: [],
      openRouterKeyIndex: 0,
      huggingFaceApiKeys: [],
      huggingFaceKeyIndex: 0,
      customBaseUrl: '',
      customApiKey: '',
      customModelName: '',
      isComplexTaskMode: false,
      userBio: ''
    });
    handleNewChat();
    setShowClearConfirm(false);
  }, [setSkills, setTaughtSkills, setMessages, setAiSettings, handleNewChat]);

  const handleSelectSession = useCallback((session: ChatSession) => {
    setCurrentSessionId(session.id);
    setMessages(session.messages);
    setView('chat');
  }, [setMessages]);

  // --- RENDER ---

  return (
    <div className={`flex flex-col h-screen bg-gray-50 dark:bg-gray-900 transition-colors duration-200 ${theme}`}>
      <Header
        currentView={view}
        setView={setView}
        onNewChat={handleNewChat}
        isOnline={isOnline}
        onSearch={setSearchQuery}
        onUndo={messages.length > 0 ? () => {} : () => {}} // Implement via useUndoableLocalStorage
        onRedo={() => {}}
        canUndo={false} // Get from useUndoableLocalStorage
        canRedo={false}
        theme={theme}
        toggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      />

      <main className="flex-1 overflow-hidden relative">
        {view === 'chat' && (
          <div className="flex flex-col h-full">
            <ChatWindow
              messages={messages}
              isLoading={isLoading}
              searchQuery={searchQuery}
              streamingMessage={streamingMessage}
              onDeleteMessage={handleDeleteMessage}
              onRegenerateResponse={handleRegenerateResponse}
              onRateMessage={handleRateMessage}
            />
            <div ref={messagesEndRef} />
            <InputBar
              onSend={handleSendMessage}
              isLoading={isLoading}
              isOnline={isOnline}
              files={files}
              onFilesChange={setFiles}
            />
          </div>
        )}

        {view === 'history' && (
          <HistoryView onSelectSession={handleSelectSession} />
        )}

        {view === 'memory' && <MemoryBank />}

        {view === 'teach' && <TeachScreen onSaveSkill={handleSaveSkill} />}

        {view === 'upgrades' && (
          <UpgradeCenter skills={skills} taughtSkills={taughtSkills} />
        )}

        {view === 'settings' && (
          <SettingsScreen
            theme={theme}
            setTheme={setTheme}
            aiSettings={aiSettings}
            setAiSettings={setAiSettings}
            onClearData={() => setShowClearConfirm(true)}
          />
        )}
      </main>

      {pendingSkill && (
        <SkillConfirmationModal
          skill={pendingSkill}
          onConfirm={handleConfirmSkill}
          onCancel={() => setPendingSkill(null)}
        />
      )}

      {showClearConfirm && (
        <ConfirmationModal
          isOpen={showClearConfirm}
          title="Clear All Data"
          message="Are you sure you want to delete all chats, memories, and skills? This cannot be undone."
          confirmText="Clear Everything"
          cancelText="Cancel"
          onConfirm={handleClearAllData}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  );
};

export default App;
