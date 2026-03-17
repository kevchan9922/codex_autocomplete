import {
  keepLastRepeatedPrefixLineSegment,
  trimOverlapWithPrefix,
  trimOverlapWithSuffixStart,
  trimTrailingOverlapWithSuffixStart,
} from './inlineTextUtils';
import {
  applyLanguagePostProcessors,
  LanguagePostProcessor,
} from './languagePostProcessors';

export interface NormalizeSuggestionInput {
  suggestion: string;
  prefix: string;
  suffix: string;
  linePrefix?: string;
  lineSuffix?: string;
  languageId: string;
  postProcessors?: LanguagePostProcessor[];
}

export interface NormalizeSuggestionResult {
  text: string;
  repairedFrom?: string;
  repairReasons?: string[];
}

export function normalizeSuggestion(input: NormalizeSuggestionInput): NormalizeSuggestionResult {
  const normalizedLeadingWhitespace = decodeLeadingEscapedWhitespace(input.suggestion);
  const normalized = trimTrailingOverlapWithSuffixStart(
    trimOverlapWithSuffixStart(
      trimOverlapWithPrefix(
        keepLastRepeatedPrefixLineSegment(normalizedLeadingWhitespace, input.prefix),
        input.prefix,
      ),
      input.suffix,
    ),
    input.suffix,
  );

  const { suggestion: repaired, repairReasons } = applyLanguagePostProcessors(
    {
      suggestion: normalized,
      prefix: input.prefix,
      suffix: input.suffix,
      linePrefix: input.linePrefix,
      lineSuffix: input.lineSuffix,
      languageId: input.languageId,
    },
    input.postProcessors,
  );

  if (repaired !== normalized) {
    return {
      text: repaired,
      repairedFrom: normalized,
      repairReasons,
    };
  }

  return { text: normalized };
}

function decodeLeadingEscapedWhitespace(value: string): string {
  if (!value.startsWith('\\')) {
    return value;
  }

  let index = 0;
  let decoded = '';
  while (index < value.length) {
    if (value.startsWith('\\r\\n', index)) {
      decoded += '\r\n';
      index += 4;
      continue;
    }
    if (value.startsWith('\\n', index)) {
      decoded += '\n';
      index += 2;
      continue;
    }
    if (value.startsWith('\\r', index)) {
      decoded += '\r';
      index += 2;
      continue;
    }
    if (value.startsWith('\\t', index)) {
      decoded += '\t';
      index += 2;
      continue;
    }
    break;
  }

  return decoded.length > 0 ? `${decoded}${value.slice(index)}` : value;
}
