import type * as vscode from 'vscode';
import { CompletionPayload } from './completionPipeline';
import { RecencyContextStore } from './contextEnrichmentCore';
import { takeFirstLines, takeLastLines } from './inlineTextUtils';
import { buildInlineRequestInstructions } from './completionInstructions';

const FULL_CONTEXT_SYMBOL_LOOKUP_TIMEOUT_MS = 40;

export interface StageRequestContext {
  prefix: string;
  suffix: string;
  linePrefix?: string;
  lineSuffix?: string;
  selection?: string;
  languageId: string;
  filePath: string;
}

export interface StageRequestConfig {
  fastStagePrefixLines: number;
  fastStageSuffixLines: number;
  completionConstraintLines?: readonly string[];
  instructions?: string;
  instructionsPrebuilt?: boolean;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheRetention?: string;
}

export interface StageRequestFactoryInput {
  context: StageRequestContext;
  dynamicCacheKey: string;
  config: StageRequestConfig;
  document: vscode.TextDocument;
  position: vscode.Position;
  snapshotText: string;
  recencyStore: RecencyContextStore;
  explicitHotkeyTrigger: boolean;
}

export interface StageRequests {
  fastRequest: CompletionPayload;
  fullRequestFactory: () => Promise<CompletionPayload>;
}

export interface ResolvedStageRequestInput {
  context: StageRequestContext;
  dynamicCacheKey?: string;
  config: StageRequestConfig;
  interactionMode: 'automatic' | 'hotkey';
  fullContextFactory: () => Promise<string | undefined>;
}

export function buildResolvedStageRequests(input: ResolvedStageRequestInput): StageRequests {
  const normalizedContext = normalizeStageContext(input.context);
  const requestInstructions = input.config.instructionsPrebuilt
    ? input.config.instructions
    : buildInlineRequestInstructions(
      undefined,
      normalizedContext.prefix,
      normalizedContext.suffix,
      {
        languageId: normalizedContext.languageId,
        linePrefix: normalizedContext.linePrefix,
        lineSuffix: normalizedContext.lineSuffix,
        completionConstraintLines: input.config.completionConstraintLines,
      },
    );
  const promptCacheBase = input.dynamicCacheKey && input.dynamicCacheKey.length > 0
    ? input.dynamicCacheKey
    : undefined;

  const fastRequest: CompletionPayload = {
    prefix: takeLastLines(
      normalizedContext.prefix,
      input.config.fastStagePrefixLines,
    ),
    suffix: takeFirstLines(
      normalizedContext.suffix,
      input.config.fastStageSuffixLines,
    ),
    linePrefix: normalizedContext.linePrefix,
    lineSuffix: normalizedContext.lineSuffix,
    selection: normalizedContext.selection,
    languageId: normalizedContext.languageId,
    filePath: normalizedContext.filePath,
    context: undefined,
    instructions: requestInstructions,
    maxOutputTokens: input.config.maxOutputTokens,
    serviceTier: input.config.serviceTier,
    promptCacheKey: promptCacheBase ? `${promptCacheBase}:fast` : undefined,
    promptCacheRetention: input.config.promptCacheRetention,
    priority: 'high',
    interactionMode: input.interactionMode,
  };

  let fullRequestPromise: Promise<CompletionPayload> | undefined;
  const fullRequestFactory = (): Promise<CompletionPayload> => {
    if (!fullRequestPromise) {
      fullRequestPromise = (async (): Promise<CompletionPayload> => {
        const extraContext = await input.fullContextFactory();

        return {
          prefix: normalizedContext.prefix,
          suffix: normalizedContext.suffix,
          linePrefix: normalizedContext.linePrefix,
          lineSuffix: normalizedContext.lineSuffix,
          selection: normalizedContext.selection,
          languageId: normalizedContext.languageId,
          filePath: normalizedContext.filePath,
          context: extraContext,
          instructions: requestInstructions,
          maxOutputTokens: input.config.maxOutputTokens,
          serviceTier: input.config.serviceTier,
          promptCacheKey: promptCacheBase ? `${promptCacheBase}:full` : undefined,
          promptCacheRetention: input.config.promptCacheRetention,
          priority: 'high',
          interactionMode: input.interactionMode,
        };
      })();
    }

    return fullRequestPromise;
  };

  return {
    fastRequest,
    fullRequestFactory,
  };
}

function normalizeStageContext(context: StageRequestContext): StageRequestContext {
  return {
    ...context,
    prefix: normalizeContextText(context.prefix),
    suffix: normalizeContextText(context.suffix),
    linePrefix: context.linePrefix === undefined
      ? undefined
      : normalizeLineContextText(context.linePrefix),
    lineSuffix: context.lineSuffix === undefined
      ? undefined
      : normalizeLineContextText(context.lineSuffix),
    selection: context.selection === undefined
      ? undefined
      : normalizeContextText(context.selection),
  };
}

function normalizeContextText(value: string): string {
  return (value || '')
    .replace(/\u0000/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function normalizeLineContextText(value: string): string {
  return normalizeContextText(value).replace(/[\r\n]/g, '');
}

export function buildStageRequests(input: StageRequestFactoryInput): StageRequests {
  return buildResolvedStageRequests({
    context: input.context,
    dynamicCacheKey: input.dynamicCacheKey,
    config: input.config,
    interactionMode: input.explicitHotkeyTrigger ? 'hotkey' : 'automatic',
    fullContextFactory: async (): Promise<string | undefined> => {
      const { buildExtraContext } = await import('./contextEnrichment');
      return buildExtraContext(
        input.document,
        input.position,
        input.snapshotText,
        input.recencyStore.getRecentEntries(input.document.uri.fsPath),
        {
          // Keep symbol-provider lookups bounded for full-context enrichment in all modes.
          includeCurrentSymbol: true,
          symbolLookupTimeoutMs: FULL_CONTEXT_SYMBOL_LOOKUP_TIMEOUT_MS,
        },
      );
    },
  });
}
