const Module = require('node:module');

const defaultConfig = {
  enabled: true,
  endpoint: 'https://chatgpt.com/backend-api/codex/responses',
  endpointMode: 'auto',
  model: 'gpt-5.2-codex',
  triggerMode: 'hotkey',
  debounceMs: 100,
  maxLatencyMs: 15000,
  firstChunkMaxLatencyMs: 1400,
  maxContextLines: 100,
  maxFileLines: 5000,
  rateLimitWindowSec: 10,
  rateLimitMaxRequests: 5,
};

const commandHandlers = new Map();

const vscodeStub = {
  ProgressLocation: {
    Window: 10,
    Notification: 15,
  },
  InlineCompletionTriggerKind: {
    Automatic: 0,
    Invoke: 1,
  },
  window: {
    showInputBox: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }),
    withProgress: async (_options, task) => task(),
    createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {} }),
    activeTextEditor: undefined,
  },
  env: {
    openExternal: async () => true,
  },
  Uri: {
    parse: (value) => ({ fsPath: value }),
  },
  commands: {
    registerCommand: (commandId, handler) => {
      commandHandlers.set(commandId, handler);
      return {
        dispose() {
          commandHandlers.delete(commandId);
        },
      };
    },
    executeCommand: async (commandId, ...args) => {
      const handler = commandHandlers.get(commandId);
      if (!handler) {
        return undefined;
      }
      return handler(...args);
    },
  },
  languages: {
    registerInlineCompletionItemProvider: () => ({ dispose() {} }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (key, defaultValue) => (key in defaultConfig ? defaultConfig[key] : defaultValue),
    }),
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad(request, parent, isMain);
};
