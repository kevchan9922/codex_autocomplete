import * as vscode from 'vscode';
import { beginLogin, LoginCancelledError } from './auth/oauth';
import { NotAuthenticatedError, TokenManager } from './auth/tokenManager';
import { InlineCompletionProvider } from './completion/inlineProvider';
import {
  buildCompletionContext,
  CompletionContext,
  DEFAULT_CONTEXT_CONFIG,
} from './completion/contextBuilder';
import { RecencyContextStore } from './completion/contextEnrichment';
import { createAIProvider } from './api/providerFactory';
import {
  buildCodexRequestBodyObject,
} from './api/codexProvider';
import {
  codexDebug,
  codexLog,
  setCodexLogLevel,
  setCodexLogSink,
} from './logging/codexLogger';
import { runAutocompleteBulkTest } from './debug/bulkTestRunner';
import { getDebugOutputChannel } from './debug/outputChannel';
import { runAutocompleteResponseTimeTest } from './debug/responseTimeRunner';
import { InlineUiController } from './completion/inlineUiController';
import { buildStageRequests } from './completion/stageRequestFactory';
import { buildPromptCacheKey } from './completion/promptCacheKey';
import { buildInlineRequestInstructions } from './completion/completionInstructions';
import {
  buildCompletionRequestLogFields,
  formatCompletionRequestLogFields,
} from './completion/requestDiagnostics';
import {
  INLINE_PROVIDER_INTERNAL_DEFAULTS,
  WORKSPACE_SETTING_DEFAULTS,
} from './configDefaults';

interface ExtensionConfig {
  enabled: boolean;
  triggerMode: 'automatic' | 'hotkey';
  endpoint: string;
  endpointMode: 'auto' | 'oauth' | 'apiKey' | 'custom';
  model: string;
  completionConstraintLines: string[];
  debounceMs: number;
  maxLatencyMs: number;
  firstChunkMaxLatencyMs: number;
  maxContextLines: number;
  maxFileLines: number;
  rateLimitWindowSec: number;
  rateLimitMaxRequests: number;
  maxOutputTokens: number;
  serviceTier: string;
  promptCacheKey: string;
  promptCacheRetention: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'off';
}

const DEFAULT_CONFIG: ExtensionConfig = { ...WORKSPACE_SETTING_DEFAULTS };

const OAUTH_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const API_KEY_ENDPOINT = 'https://api.openai.com/v1/responses';
const INLINE_SUGGESTION_ACCEPTED_COMMAND = 'codexAutocomplete._inlineSuggestionAccepted';

interface InlineSuggestionAcceptedPayload {
  requestId?: number;
  editorKey?: string;
  line?: number;
  character?: number;
  suggestionLength?: number;
  suggestionPreview?: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tokenManager = new TokenManager(context.secrets);
  let inlineProviderRegistration: vscode.Disposable | undefined;
  let inlineCompletionProvider: InlineCompletionProvider | undefined;
  const inlineUiController = new InlineUiController();
  context.subscriptions.push({ dispose: () => inlineUiController.dispose() });

  setCodexLogLevel(getExtensionConfig().logLevel);
  setCodexLogSink((line) => getDebugOutputChannel().appendLine(line));
  context.subscriptions.push({ dispose: () => setCodexLogSink(undefined) });

  const loginCommand = vscode.commands.registerCommand('codexAutocomplete.login', async () => {
    try {
      const tokens = await beginLogin();
      await tokenManager.saveTokens(tokens);
      await refreshInlineProvider();
      await vscode.window.showInformationMessage('Codex Autocomplete: logged in.');
    } catch (err) {
      if (err instanceof LoginCancelledError) {
        await vscode.window.showInformationMessage('Codex Autocomplete login cancelled.');
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      await vscode.window.showErrorMessage(`Codex Autocomplete login failed: ${message}`);
    }
  });

  const logoutCommand = vscode.commands.registerCommand('codexAutocomplete.logout', async () => {
    try {
      const hasToken = await tokenManager.hasToken();
      if (!hasToken) {
        await refreshInlineProvider();
        await vscode.window.showInformationMessage('Codex Autocomplete: already logged out.');
        return;
      }

      await tokenManager.logout();
      await refreshInlineProvider();
      await vscode.window.showInformationMessage('Codex Autocomplete: logged out.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await vscode.window.showErrorMessage(`Codex Autocomplete logout failed: ${message}`);
    }
  });

  const prepareManualInlineTrigger = async (): Promise<boolean> => {
    if (!inlineCompletionProvider) {
      await vscode.window.showInformationMessage(
        'Codex Autocomplete: not logged in. Run Codex Autocomplete: Login.',
      );
      codexLog('[codex] manual trigger ignored: inline provider unavailable');
      return false;
    }

    inlineCompletionProvider.markManualTriggerWindow();
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (activeDocument) {
      inlineCompletionProvider.markManualTriggerForDocument(activeDocument);
    }
    return true;
  };

  const triggerCommand = vscode.commands.registerCommand('codexAutocomplete.trigger', async () => {
    if (!(await prepareManualInlineTrigger())) {
      return;
    }
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    codexLog('[codex] forwarded trigger command to editor.action.inlineSuggest.trigger');
  });

  const inlineSuggestionAcceptedCommand = vscode.commands.registerCommand(
    INLINE_SUGGESTION_ACCEPTED_COMMAND,
    (...args: unknown[]) => {
      const payload = args[0] as InlineSuggestionAcceptedPayload | undefined;
      const requestId =
        typeof payload?.requestId === 'number' && Number.isFinite(payload.requestId)
          ? payload.requestId
          : -1;
      const editorKey = payload?.editorKey ?? 'unknown';
      const line =
        typeof payload?.line === 'number' && Number.isFinite(payload.line) ? payload.line : -1;
      const char =
        typeof payload?.character === 'number' && Number.isFinite(payload.character)
          ? payload.character
          : -1;
      const length =
        typeof payload?.suggestionLength === 'number' && Number.isFinite(payload.suggestionLength)
          ? payload.suggestionLength
          : -1;
      const preview = payload?.suggestionPreview ? ` preview=${JSON.stringify(payload.suggestionPreview)}` : '';
      codexLog(
        `[codex] ghost text accepted requestId=${requestId} editor=${editorKey} line=${line} char=${char} len=${length}${preview}`,
      );
    },
  );

  const debugTokenCommand = vscode.commands.registerCommand('codexAutocomplete.debugToken', async () => {
    try {
      await tokenManager.getAccessToken();
      await vscode.window.showInformationMessage('Codex Autocomplete: token is available.');
    } catch (err) {
      if (err instanceof NotAuthenticatedError) {
        await vscode.window.showInformationMessage('Codex Autocomplete: not logged in.');
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      await vscode.window.showErrorMessage(`Codex Autocomplete token check failed: ${message}`);
    }
  });

  const debugContextCommand = vscode.commands.registerCommand(
    'codexAutocomplete.debugContext',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showInformationMessage('Codex Autocomplete: no active editor.');
        return;
      }

      const document = editor.document;
      const selection = editor.selection;
      const snapshot = {
        text: document.getText(),
        languageId: document.languageId,
        filePath: document.uri.fsPath,
        selection: document.getText(selection),
      };

      const cursor = {
        line: selection.active.line,
        character: selection.active.character,
      };

      const result = buildCompletionContext(snapshot, cursor, {
        ...DEFAULT_CONTEXT_CONFIG,
        maxBeforeLines: getExtensionConfig().maxContextLines,
        maxFileLines: getExtensionConfig().maxFileLines,
      });

      if (result.truncatedForFileSize) {
        await vscode.window.showInformationMessage(
          `Codex Autocomplete: large file (${result.lineCount} lines); using local truncated context.`,
        );
      }

      const output = getDebugOutputChannel();
      output.clear();
      const settings = getExtensionConfig();
      const endpoint = await resolveDebugEndpoint(settings, tokenManager);
      const report = await buildDebugContextReport({
        document,
        position: cursor,
        snapshotText: snapshot.text,
        context: result.context,
        endpoint,
        triggerMode: settings.triggerMode,
        model: settings.model,
        completionConstraintLines: settings.completionConstraintLines,
        maxOutputTokens: settings.maxOutputTokens,
        serviceTier: settings.serviceTier,
        promptCacheKey: settings.promptCacheKey,
        promptCacheRetention: settings.promptCacheRetention,
      });
      const reportJson = JSON.stringify(report, null, 2);
      output.appendLine('[debug-context] request report:');
      output.appendLine(reportJson);
      output.show(true);
    },
  );

  const debugCompletionCommand = vscode.commands.registerCommand(
    'codexAutocomplete.debugCompletion',
    async () => {
      const output = getDebugOutputChannel();
      output.clear();
      output.appendLine('Running debug completion...');

      if (!(await tokenManager.hasToken())) {
        output.appendLine('Not logged in. Run Codex Autocomplete: Login first.');
        output.show(true);
        return;
      }

      const settings = getExtensionConfig();
      let endpoint = settings.endpoint;
      try {
        endpoint = await resolveEndpoint(settings, tokenManager);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        output.appendLine(`Endpoint resolution failed: ${message}`);
        output.show(true);
        return;
      }

      const debugProvider = createAIProvider(tokenManager, {
        endpoint,
        model: settings.model,
        rateLimitWindowSec: settings.rateLimitWindowSec,
        rateLimitMaxRequests: settings.rateLimitMaxRequests,
      });

      const sampleInstructions = buildInlineRequestInstructions(
        undefined,
        'def example(name: str) -> str:\n    return ',
        '',
        {
          languageId: 'python',
          completionConstraintLines: settings.completionConstraintLines,
        },
      );
      const sampleRequest = {
        prefix: 'def example(name: str) -> str:\n    return ',
        suffix: '',
        languageId: 'python',
        filePath: 'debug.py',
        context: 'Provide a short completion for the return value.',
        instructions: sampleInstructions,
        maxOutputTokens: settings.maxOutputTokens,
        serviceTier: settings.serviceTier,
        promptCacheKey: settings.promptCacheKey,
        promptCacheRetention: settings.promptCacheRetention,
      };

      const controller = new AbortController();
      let responseText = '';

      try {
        for await (const chunk of debugProvider.streamCompletion(sampleRequest, controller.signal)) {
          if (chunk.done) {
            break;
          }
          responseText += chunk.text;
          if (responseText.length > 2000) {
            responseText = responseText.slice(0, 2000);
            break;
          }
        }

        if (!responseText.trim()) {
          output.appendLine('No response text received.');
        } else {
          output.appendLine('Response:');
          output.appendLine(responseText);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        output.appendLine(`Debug completion failed: ${message}`);
      }

      output.show(true);
    },
  );

  const debugMetricsCommand = vscode.commands.registerCommand(
    'codexAutocomplete.debugMetrics',
    async () => {
      const output = getDebugOutputChannel();
      output.clear();
      output.appendLine('Inline completion metrics snapshot:');

      if (!inlineCompletionProvider) {
        output.appendLine('No inline provider is active.');
      } else {
        output.appendLine(
          JSON.stringify(inlineCompletionProvider.getDebugMetrics(), null, 2),
        );
      }

      output.show(true);
    },
  );

  const triggerHotkeyCommand = vscode.commands.registerCommand(
    'codexAutocomplete.triggerHotkey',
    async () => {
      const settings = getExtensionConfig();
      codexDebug(
        `[codex] hotkey command invoked mode=${settings.triggerMode}`,
      );

      if (!(await prepareManualInlineTrigger())) {
        return;
      }
      inlineUiController.notifyHotkeyTriggered();
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      codexDebug('[codex] forwarded hotkey to editor.action.inlineSuggest.trigger');
    },
  );


  const debugAutocompleteBulkTestCommand = vscode.commands.registerCommand(
    'codexAutocomplete.debugAutocompleteBulkTest',
    async () => {
      void vscode.window.showInformationMessage('autocomplete bulk test initiated');
      const output = getDebugOutputChannel();
      output.clear();
      output.appendLine('Running autocomplete bulk test...');

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceFolder) {
        output.appendLine('No workspace folder is open.');
        output.show(true);
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        output.appendLine('No active editor for building debug context.');
        output.show(true);
        return;
      }

      const settings = getExtensionConfig();
      let endpoint = settings.endpoint;
      try {
        endpoint = await resolveEndpoint(settings, tokenManager);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        output.appendLine(`Endpoint resolution failed: ${message}`);
        output.show(true);
        return;
      }

      const debugProvider = createAIProvider(tokenManager, {
        endpoint,
        model: settings.model,
        rateLimitWindowSec: settings.rateLimitWindowSec,
        rateLimitMaxRequests: settings.rateLimitMaxRequests,
        maxOutputTokens: settings.maxOutputTokens,
        serviceTier: settings.serviceTier,
        promptCacheKey: settings.promptCacheKey,
        promptCacheRetention: settings.promptCacheRetention,
      });

      await runAutocompleteBulkTest({
        workspaceFolder,
        output,
        provider: debugProvider,
        languageId: editor.document.languageId,
        filePath: editor.document.uri.fsPath,
        instructions: '',
        maxOutputTokens: settings.maxOutputTokens,
        serviceTier: settings.serviceTier,
        promptCacheKey: settings.promptCacheKey,
        promptCacheRetention: settings.promptCacheRetention,
        benchmarkMode: 'hotkey_inline',
        buildContext: () => buildDebugContextString(editor, settings, endpoint),
      });

      output.show(true);
    },
  );

  const debugResponseTimeTestCommand = vscode.commands.registerCommand(
    'codexAutocomplete.debugResponseTimeTest',
    async () => {
      void vscode.window.showInformationMessage('response time test initiated');
      const output = getDebugOutputChannel();
      output.clear();
      output.appendLine('Running end-to-end response time test...');

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceFolder) {
        output.appendLine('No workspace folder is open.');
        output.show(true);
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        output.appendLine('No active editor for building debug context.');
        output.show(true);
        return;
      }

      const settings = getExtensionConfig();
      let endpoint = settings.endpoint;
      try {
        endpoint = await resolveEndpoint(settings, tokenManager);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        output.appendLine(`Endpoint resolution failed: ${message}`);
        output.show(true);
        return;
      }

      const debugProvider = createAIProvider(tokenManager, {
        endpoint,
        model: settings.model,
        rateLimitWindowSec: settings.rateLimitWindowSec,
        rateLimitMaxRequests: settings.rateLimitMaxRequests,
        maxOutputTokens: settings.maxOutputTokens,
        serviceTier: settings.serviceTier,
        promptCacheKey: settings.promptCacheKey,
        promptCacheRetention: settings.promptCacheRetention,
      });

      await runAutocompleteResponseTimeTest({
        workspaceFolder,
        output,
        provider: debugProvider,
        languageId: editor.document.languageId,
        filePath: editor.document.uri.fsPath,
        model: settings.model,
        endpoint,
        instructions: '',
        maxOutputTokens: settings.maxOutputTokens,
        serviceTier: settings.serviceTier,
        promptCacheKey: settings.promptCacheKey,
        promptCacheRetention: settings.promptCacheRetention,
        benchmarkMode: 'hotkey_inline',
        buildContext: () => buildDebugContextString(editor, settings, endpoint),
      });

      output.show(true);
    },
  );

  const refreshInlineProvider = async (): Promise<void> => {
    inlineProviderRegistration?.dispose();
    inlineProviderRegistration = undefined;
    inlineCompletionProvider?.dispose();
    inlineCompletionProvider = undefined;

    const settings = getExtensionConfig();
    setCodexLogLevel(settings.logLevel);
    if (!settings.enabled) {
      return;
    }

    const hasToken = await tokenManager.hasToken();
    if (!hasToken) {
      codexLog('[codex] inline provider disabled: not authenticated');
      return;
    }

    let endpoint = settings.endpoint;
    try {
      endpoint = await resolveEndpoint(settings, tokenManager);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await vscode.window.showErrorMessage(
        `Codex Autocomplete endpoint resolution failed: ${message}`,
      );
    }

    const aiProvider = createAIProvider(tokenManager, {
      endpoint,
      model: settings.model,
      rateLimitWindowSec: settings.rateLimitWindowSec,
      rateLimitMaxRequests: settings.rateLimitMaxRequests,
      maxOutputTokens: settings.maxOutputTokens,
      serviceTier: settings.serviceTier,
      promptCacheKey: settings.promptCacheKey,
      promptCacheRetention: settings.promptCacheRetention,
    });

    codexLog(
      `[codex] config model=${settings.model} endpoint=${endpoint} debounceMs=${settings.debounceMs} maxLatencyMs=${settings.maxLatencyMs} firstChunkMaxLatencyMs=${settings.firstChunkMaxLatencyMs} maxOutputTokens=${settings.maxOutputTokens} serviceTier=${settings.serviceTier}`,
    );

    inlineCompletionProvider = new InlineCompletionProvider(aiProvider, undefined, {
      debounceMs: settings.debounceMs,
      triggerMode: settings.triggerMode,
      completionConstraintLines: settings.completionConstraintLines,
      maxLatencyMs: settings.maxLatencyMs,
      firstChunkMaxLatencyMs: settings.firstChunkMaxLatencyMs,
      context: {
        ...DEFAULT_CONTEXT_CONFIG,
        maxBeforeLines: settings.maxContextLines,
        maxFileLines: settings.maxFileLines,
      },
      maxOutputTokens: settings.maxOutputTokens,
      serviceTier: settings.serviceTier,
      promptCacheKey: settings.promptCacheKey,
      promptCacheRetention: settings.promptCacheRetention,
      acceptanceLogCommandId: INLINE_SUGGESTION_ACCEPTED_COMMAND,
    });

    inlineProviderRegistration = vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      inlineCompletionProvider,
    );

    context.subscriptions.push(inlineProviderRegistration);
  };

  await refreshInlineProvider();

  const settingsWatcher = (vscode.workspace as unknown as {
    onDidChangeConfiguration?: (listener: (event: { affectsConfiguration: (section: string) => boolean }) => void) => vscode.Disposable;
  }).onDidChangeConfiguration?.(async (event) => {
    if (event.affectsConfiguration('codexAutocomplete')) {
      await refreshInlineProvider();
    }
  });

  if (settingsWatcher) {
    context.subscriptions.push(settingsWatcher);
  }

  context.subscriptions.push(
    loginCommand,
    logoutCommand,
    triggerCommand,
    inlineSuggestionAcceptedCommand,
    debugTokenCommand,
    debugContextCommand,
    debugCompletionCommand,
    debugMetricsCommand,
    triggerHotkeyCommand,
    debugAutocompleteBulkTestCommand,
    debugResponseTimeTestCommand,
  );
}

export function deactivate(): void {
  // Reserved for cleanup hooks in later phases.
}

function getExtensionConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('codexAutocomplete');
  const mode = config.get<string>('endpointMode', DEFAULT_CONFIG.endpointMode);
  const endpointMode =
    mode === 'oauth' || mode === 'apiKey' || mode === 'custom' ? mode : 'auto';

  return {
    enabled: config.get<boolean>('enabled', DEFAULT_CONFIG.enabled),
    triggerMode:
      config.get<string>('triggerMode', DEFAULT_CONFIG.triggerMode) === 'hotkey'
        ? 'hotkey'
        : 'automatic',
    endpoint: config.get<string>('endpoint', DEFAULT_CONFIG.endpoint),
    endpointMode,
    model: config.get<string>('model', DEFAULT_CONFIG.model),
    completionConstraintLines: config.get<string[]>(
      'completionConstraintLines',
      DEFAULT_CONFIG.completionConstraintLines,
    ),
    debounceMs: config.get<number>('debounceMs', DEFAULT_CONFIG.debounceMs),
    maxLatencyMs: config.get<number>('maxLatencyMs', DEFAULT_CONFIG.maxLatencyMs),
    firstChunkMaxLatencyMs: config.get<number>(
      'firstChunkMaxLatencyMs',
      DEFAULT_CONFIG.firstChunkMaxLatencyMs,
    ),
    maxContextLines: config.get<number>('maxContextLines', DEFAULT_CONFIG.maxContextLines),
    maxFileLines: config.get<number>('maxFileLines', DEFAULT_CONFIG.maxFileLines),
    rateLimitWindowSec: config.get<number>(
      'rateLimitWindowSec',
      DEFAULT_CONFIG.rateLimitWindowSec,
    ),
    rateLimitMaxRequests: config.get<number>(
      'rateLimitMaxRequests',
      DEFAULT_CONFIG.rateLimitMaxRequests,
    ),
    maxOutputTokens: config.get<number>('maxOutputTokens', DEFAULT_CONFIG.maxOutputTokens),
    serviceTier: config.get<string>('serviceTier', DEFAULT_CONFIG.serviceTier),
    promptCacheKey: config.get<string>('promptCacheKey', DEFAULT_CONFIG.promptCacheKey),
    promptCacheRetention: config.get<string>(
      'promptCacheRetention',
      DEFAULT_CONFIG.promptCacheRetention,
    ),
    logLevel: normalizeLogLevel(
      config.get<string>('logLevel', DEFAULT_CONFIG.logLevel),
    ),
  };
}

async function resolveEndpoint(
  settings: ExtensionConfig,
  tokenManager: TokenManager,
): Promise<string> {
  if (settings.endpointMode === 'oauth') {
    return OAUTH_ENDPOINT;
  }
  if (settings.endpointMode === 'apiKey') {
    return API_KEY_ENDPOINT;
  }
  if (settings.endpointMode === 'custom') {
    return settings.endpoint;
  }

  const hint = await tokenManager.getTokenTypeHint();
  if (hint === 'apiKey') {
    return API_KEY_ENDPOINT;
  }
  if (hint === 'oauth') {
    return OAUTH_ENDPOINT;
  }

  return settings.endpoint;
}
async function buildDebugContextString(
  editor: vscode.TextEditor,
  settings: ExtensionConfig,
  endpoint: string,
): Promise<string> {
  const document = editor.document;
  const selection = editor.selection;
  const snapshot = {
    text: document.getText(),
    languageId: document.languageId,
    filePath: document.uri.fsPath,
    selection: document.getText(selection),
  };

  const cursor = {
    line: selection.active.line,
    character: selection.active.character,
  };

  const result = buildCompletionContext(snapshot, cursor, {
    ...DEFAULT_CONTEXT_CONFIG,
    maxBeforeLines: settings.maxContextLines,
    maxFileLines: settings.maxFileLines,
  });

  const stageRequests = buildStageRequests({
    context: result.context,
    dynamicCacheKey: buildPromptCacheKey(
      settings.promptCacheKey,
      result.context,
    ),
    config: {
      fastStagePrefixLines: INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStagePrefixLines,
      fastStageSuffixLines: INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStageSuffixLines,
      completionConstraintLines: settings.completionConstraintLines,
      maxOutputTokens: settings.maxOutputTokens,
      serviceTier: settings.serviceTier,
      promptCacheRetention: settings.promptCacheRetention,
    },
    document,
    position: selection.active,
    snapshotText: snapshot.text,
    recencyStore: new RecencyContextStore(),
    explicitHotkeyTrigger: true,
  });
  const fullRequest = await stageRequests.fullRequestFactory();

  return JSON.stringify({
    ...result.context,
    context: fullRequest.context,
  }, null, 2);
}

async function buildDebugContextReport(input: {
  document: vscode.TextDocument;
  position: vscode.Position;
  snapshotText: string;
  context: CompletionContext;
  endpoint: string;
  triggerMode: 'automatic' | 'hotkey';
  model: string;
  completionConstraintLines: string[];
  maxOutputTokens: number;
  serviceTier: string;
  promptCacheKey: string;
  promptCacheRetention: string;
}): Promise<Record<string, unknown>> {
  const explicitHotkeyTrigger = input.triggerMode === 'hotkey';
  const stageRequests = buildStageRequests({
    context: input.context,
    dynamicCacheKey: buildPromptCacheKey(
      input.promptCacheKey,
      input.context,
    ),
    config: {
      fastStagePrefixLines: INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStagePrefixLines,
      fastStageSuffixLines: INLINE_PROVIDER_INTERNAL_DEFAULTS.fastStageSuffixLines,
      completionConstraintLines: input.completionConstraintLines,
      maxOutputTokens: input.maxOutputTokens,
      serviceTier: input.serviceTier,
      promptCacheRetention: input.promptCacheRetention,
    },
    document: input.document,
    position: input.position,
    snapshotText: input.snapshotText,
    recencyStore: new RecencyContextStore(),
    explicitHotkeyTrigger,
  });
  const fullRequest = await stageRequests.fullRequestFactory();
  const apiOptimized = input.endpoint.includes('api.openai.com');
  const fastRequestBody = buildCodexRequestBodyObject(stageRequests.fastRequest, {
    endpoint: input.endpoint,
    model: input.model,
  });
  const fullRequestBody = buildCodexRequestBodyObject(fullRequest, {
    endpoint: input.endpoint,
    model: input.model,
  });
  const fastInputText = extractRequestInputText(fastRequestBody);
  const fullInputText = extractRequestInputText(fullRequestBody);

  return {
    source: 'debug_context',
    trigger_mode: input.triggerMode,
    explicit_hotkey_trigger: explicitHotkeyTrigger,
    endpoint: input.endpoint,
    api_optimized: apiOptimized,
    context_builder: {
      language_id: input.context.languageId,
      file_path: input.context.filePath,
      hash: input.context.hash,
      cursor: input.context.cursor,
      truncated: input.context.truncated,
      before_lines: input.context.beforeLines.length,
      after_lines: input.context.afterLines.length,
      line_prefix: input.context.linePrefix,
      line_suffix: input.context.lineSuffix,
    },
    fast_prompt_payload: parseInputTextPayload(fastInputText),
    full_prompt_payload: parseInputTextPayload(fullInputText),
    fast_request_summary: formatCompletionRequestLogFields(
      buildCompletionRequestLogFields(stageRequests.fastRequest, {
        source: 'debug_context',
        stage: 'fast',
        contextHash: input.context.hash,
      }),
    ),
    full_request_summary: formatCompletionRequestLogFields(
      buildCompletionRequestLogFields(fullRequest, {
        source: 'debug_context',
        stage: 'full',
        contextHash: input.context.hash,
      }),
    ),
    fast_request_body: fastRequestBody,
    full_request_body: fullRequestBody,
  };
}

function extractRequestInputText(requestBody: Record<string, unknown>): string {
  const input = requestBody.input;
  if (!Array.isArray(input) || input.length === 0) {
    return '';
  }

  const firstMessage = input[0];
  if (!firstMessage || typeof firstMessage !== 'object') {
    return '';
  }

  const content = (firstMessage as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }

  const firstContent = content[0];
  if (!firstContent || typeof firstContent !== 'object') {
    return '';
  }

  const text = (firstContent as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function parseInputTextPayload(inputText: string): unknown {
  if (!inputText) {
    return {};
  }

  try {
    return JSON.parse(inputText);
  } catch {
    return { raw_input_text: inputText };
  }
}

async function resolveDebugEndpoint(
  settings: ExtensionConfig,
  tokenManager: TokenManager,
): Promise<string> {
  try {
    return await resolveEndpoint(settings, tokenManager);
  } catch {
    return settings.endpoint;
  }
}

function normalizeLogLevel(value: string): 'debug' | 'info' | 'warn' | 'error' | 'off' {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'debug'
    || normalized === 'info'
    || normalized === 'warn'
    || normalized === 'error'
    || normalized === 'off'
  ) {
    return normalized;
  }
  return 'info';
}
