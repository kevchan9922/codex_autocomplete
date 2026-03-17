export function trimOverlapWithPrefix(suggestion: string, prefix: string): string {
  if (!suggestion || !prefix) {
    return suggestion;
  }

  const prefixLine = prefix.split(/\r?\n/).pop() ?? '';
  const normalizedPrefixLine = prefixLine.trimEnd();
  if (!normalizedPrefixLine.trim()) {
    return suggestion;
  }

  let remaining = suggestion;

  // Iteratively trim overlap and repeated-prefix artifacts at the start of the
  // suggestion, e.g. `prefix + spaces + prefix + completion`.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = remaining;
    remaining = trimOneOverlap(remaining, normalizedPrefixLine);

    const leadingIndentMatch = remaining.match(/^[ \t]+/);
    const leadingIndentLength = leadingIndentMatch ? leadingIndentMatch[0].length : 0;
    const withoutLeadingIndent = remaining.slice(leadingIndentLength);
    if (withoutLeadingIndent.startsWith(normalizedPrefixLine)) {
      remaining = withoutLeadingIndent.slice(normalizedPrefixLine.length);
    }

    if (remaining === before) {
      break;
    }
  }

  return remaining;
}

function trimOneOverlap(value: string, prefixLine: string): string {
  const maxCheck = Math.min(prefixLine.length, value.length);
  for (let size = maxCheck; size > 0; size -= 1) {
    const overlap = prefixLine.slice(prefixLine.length - size);
    if (value.startsWith(overlap)) {
      // Avoid clipping valid suffix suggestions from accidental single-char overlap,
      // e.g. `per()` after a prefix ending in `...up`.
      if (size < 2 && !shouldTrimSingleCharIdentifierOverlap(value, prefixLine, overlap)) {
        return value;
      }
      return value.slice(size);
    }
  }
  return value;
}

function shouldTrimSingleCharIdentifierOverlap(
  value: string,
  prefixLine: string,
  overlap: string,
): boolean {
  if (overlap.length !== 1 || !/[A-Za-z_]/.test(overlap)) {
    return false;
  }

  const trimmedPrefix = prefixLine.trimEnd();
  if (!/(?:\.|::)[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedPrefix)) {
    return false;
  }

  const trailingIdentifier = trimmedPrefix.match(/([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? '';
  if (trailingIdentifier.length < 3) {
    return false;
  }

  const trimmedValue = value.trimStart();
  const leadingTokenMatch = /^([A-Za-z_][A-Za-z0-9_]{2,})(?:\(|[^\w]|$)/.exec(trimmedValue);
  if (!leadingTokenMatch) {
    return false;
  }

  if (leadingTokenMatch[1][0] !== overlap) {
    return false;
  }

  if (/[A-Z]/.test(trailingIdentifier)) {
    return true;
  }

  return /^[a-z_][a-z0-9_]*$/.test(trailingIdentifier)
    && /^[a-z_][a-z0-9_]*$/.test(leadingTokenMatch[1]);
}

export function keepLastRepeatedPrefixLineSegment(
  suggestion: string,
  prefix: string,
): string {
  if (!suggestion || !prefix) {
    return suggestion;
  }

  const prefixLine = prefix.split(/\r?\n/).pop() ?? '';
  const anchor = prefixLine.trim();
  if (anchor.length < 4) {
    return suggestion;
  }

  const lowerSuggestion = suggestion.toLowerCase();
  const lowerAnchor = anchor.toLowerCase();
  const first = lowerSuggestion.indexOf(lowerAnchor);
  const last = lowerSuggestion.lastIndexOf(lowerAnchor);

  if (first >= 0 && last > first) {
    return suggestion.slice(last);
  }

  return suggestion;
}

export function trimOverlapWithSuffixStart(suggestion: string, suffix: string): string {
  if (!suggestion || !suffix) {
    return suggestion;
  }

  const suffixLine = suffix.split(/\r?\n/)[0] ?? '';
  if (!suffixLine) {
    return suggestion;
  }

  const maxCheck = Math.min(suffixLine.length, suggestion.length);
  for (let size = maxCheck; size > 0; size -= 1) {
    const overlap = suggestion.slice(0, size);
    if (!suffixLine.startsWith(overlap)) {
      continue;
    }

    // Avoid trimming on tiny accidental overlaps like a single character.
    if (size < 3) {
      return suggestion;
    }

    return suggestion.slice(size);
  }

  return suggestion;
}

export function trimTrailingOverlapWithSuffixStart(
  suggestion: string,
  suffix: string,
): string {
  if (!suggestion || !suffix) {
    return suggestion;
  }

  const suffixLine = suffix.split(/\r?\n/)[0] ?? '';
  if (!suffixLine) {
    return suggestion;
  }

  const maxCheck = Math.min(suffixLine.length, suggestion.length);
  for (let size = maxCheck; size > 0; size -= 1) {
    const overlap = suffixLine.slice(0, size);
    if (suggestion.endsWith(overlap)) {
      return suggestion.slice(0, suggestion.length - size);
    }
  }

  return suggestion;
}

export function takeLastLines(value: string, maxLines: number): string {
  if (maxLines <= 0) {
    return '';
  }
  const lines = value.split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}

export function takeFirstLines(value: string, maxLines: number): string {
  if (maxLines <= 0) {
    return '';
  }
  const lines = value.split(/\r?\n/);
  return lines.slice(0, maxLines).join('\n');
}
