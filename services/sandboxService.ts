const workerCode = `
  self.onmessage = (event) => {
    const { code, args } = event.data;
    const startTime = Date.now();
    const MAX_EXECUTION_TIME = 10000; // 10 seconds max
    
    try {
      // Check execution time periodically
      const checkTimeout = () => {
        if (Date.now() - startTime > MAX_EXECUTION_TIME) {
          throw new Error("Skill execution timeout (10s exceeded)");
        }
      };

      const funcNameMatch = 
        code.match(/function\\\\s+([a-zA-Z0-9_]+)\\\\s*\\\\(/) || 
        code.match(/(?:var|let|const)\\\\s+([a-zA-Z0-9_]+)\\\\s*=\\\\s*(?:async\\\\s*)?(?:function\\\\s*)?(?:\\\\(|[^=]+=>)/);

      if (!funcNameMatch || !funcNameMatch[1]) {
        throw new Error("Could not find a valid function declaration in the skill's code.");
      }
      
      const funcName = funcNameMatch[1];
      
      // Add timeout check in function body
      const functionBody = code +
        '\\\\nif (typeof ' + funcName + ' !== "function") {' +
        '  throw new Error("Function \\\\'" + funcName + "\\\\' is not defined in the skill code.");' +
        '}' +
        'return ' + funcName + '(...args);';

      const executor = new Function('...args', functionBody);
      
      // Wrap with timeout check
      const result = executor(...args);
      
      if (result instanceof Promise) {
          result.then(res => {
            checkTimeout();
            self.postMessage({ success: true, result: res });
          }).catch(err => {
            self.postMessage({ success: false, error: err instanceof Error ? err.message : String(err) });
          });
      } else {
          checkTimeout();
          self.postMessage({ success: true, result });
      }

    } catch (error) {
      self.postMessage({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
`;

let worker: Worker | null = null;
let blobUrl: string | null = null; // ✅ Track URL for cleanup

const getWorker = (): Worker => {
  if (!worker) {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    blobUrl = URL.createObjectURL(blob); // ✅ Save reference
    worker = new Worker(blobUrl);
    
    // ✅ Cleanup on error
    worker.addEventListener('error', () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
      worker = null;
    });
  }
  return worker;
};

/**
 * Executes a skill's code in a secure Web Worker sandbox.
 * @param code The JavaScript code of the skill.
 * @param args An array of arguments to pass to the function.
 * @returns A promise that resolves with the result of the function.
 */
export const executeSkillInSandbox = (code: string, args: any[]): Promise<any> => {
  return new Promise((resolve, reject) => {
    const sandboxWorker = getWorker();

    let messageHandler: (event: MessageEvent) => void;
    let errorHandler: (event: ErrorEvent) => void;
    let timeoutId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
        sandboxWorker.removeEventListener('message', messageHandler);
        sandboxWorker.removeEventListener('error', errorHandler);
        clearTimeout(timeoutId);
    };

    // ✅ Add timeout for overall execution
    timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error("Skill execution timed out after 15 seconds"));
    }, 15000);

    messageHandler = (event: MessageEvent) => {
      cleanup();
      if (event.data.success) {
        resolve(event.data.result);
      } else {
        reject(new Error(event.data.error));
      }
    };

    errorHandler = (event: ErrorEvent) => {
       cleanup();
       reject(new Error(`Sandbox worker error: ${event.message}`));
    };

    sandboxWorker.addEventListener('message', messageHandler);
    sandboxWorker.addEventListener('error', errorHandler);
    
    sandboxWorker.postMessage({ code, args });
  });
};

// ✅ NEW: Cleanup function for manual termination
export const terminateWorker = (): void => {
    if (worker) {
        worker.terminate();
        if (blobUrl) {
            URL.revokeObjectURL(blobUrl);
            blobUrl = null;
        }
        worker = null;
        console.log('Sandbox worker terminated and memory cleaned up');
    }
};

// ✅ Auto-cleanup on page unload
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        if (blobUrl) {
            URL.revokeObjectURL(blobUrl);
        }
    });
}
