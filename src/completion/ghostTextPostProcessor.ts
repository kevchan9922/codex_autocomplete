import { normalizeSuggestion } from './suggestionNormalizer';
import { buildTimeoutFallbackSuggestion } from './timeoutFallback';
import { isDuplicateOfMeaningfulSuffixLine } from './blankLineHeuristics';

export interface GhostTextPostProcessorInput {
  suggestion: string;
  timedOutBeforeFirstChunk: boolean;
  prefix: string;
  suffix: string;
  filePath?: string;
  linePrefix?: string;
  lineSuffix?: string;
  languageId: string;
  beforeLines?: string[];
}

export interface GhostTextPostProcessorResult {
  text: string;
  repairedFrom?: string;
  repairReasons?: string[];
  timeoutFallback?: string;
  droppedDuplicateLaterSuffixLine?: boolean;
  droppedDuplicateLaterSuffixText?: string;
}

export function postProcessGhostTextSuggestion(
  input: GhostTextPostProcessorInput,
): GhostTextPostProcessorResult {
  let normalized = normalizeSuggestion({
    suggestion: input.suggestion,
    prefix: input.prefix,
    suffix: input.suffix,
    linePrefix: input.linePrefix,
    lineSuffix: input.lineSuffix,
    languageId: input.languageId,
  });
  const repairReasons = normalized.repairReasons ? [...normalized.repairReasons] : [];

  let timeoutFallback: string | undefined;
  const applyFallback = (): void => {
    const fallback = buildTimeoutFallbackSuggestion({
      timedOutBeforeFirstChunk: input.timedOutBeforeFirstChunk,
      languageId: input.languageId,
      prefix: input.prefix,
      suffix: input.suffix,
      filePath: input.filePath,
      lineSuffix: input.lineSuffix,
      beforeLines: input.beforeLines,
      rawSuggestion: input.suggestion,
    });
    if (fallback) {
      timeoutFallback ??= fallback;
      normalized = {
        ...normalized,
        text: fallback,
      };
    }
  };

  if (!normalized.text.trim()) {
    applyFallback();
  }

  const droppedDuplicateLaterSuffixLine = isDuplicateOfMeaningfulSuffixLine(
    normalized.text,
    input.suffix,
    input.linePrefix,
    input.lineSuffix,
  );
  const droppedDuplicateLaterSuffixText = droppedDuplicateLaterSuffixLine
    ? normalized.text
    : undefined;
  if (droppedDuplicateLaterSuffixLine) {
    repairReasons.push('dropDuplicateLaterSuffixLine');
    normalized = {
      ...normalized,
      text: '',
    };
    applyFallback();
  }

  return {
    text: normalized.text,
    repairedFrom: normalized.repairedFrom,
    repairReasons: repairReasons.length > 0 ? repairReasons : undefined,
    timeoutFallback,
    droppedDuplicateLaterSuffixLine,
    droppedDuplicateLaterSuffixText,
  };
}
