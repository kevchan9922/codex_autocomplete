export function resolveLinePrefix(prefix: string, linePrefix?: string): string {
  return linePrefix ?? (prefix.split(/\r?\n/).pop() ?? '');
}

export function getBlankLineStructuralAnchor(
  prefix: string,
  linePrefix?: string,
): string | undefined {
  const currentLinePrefix = resolveLinePrefix(prefix, linePrefix);
  if (currentLinePrefix.trim()) {
    return undefined;
  }

  const previousNonEmptyLine = getPreviousNonEmptyLine(prefix);
  if (!previousNonEmptyLine) {
    return undefined;
  }

  return isStructuralContinuationCandidate(previousNonEmptyLine)
    ? previousNonEmptyLine
    : undefined;
}

export function getStructuralCursorLinePrefix(prefix: string, linePrefix?: string): string {
  return getBlankLineStructuralAnchor(prefix, linePrefix) ?? resolveLinePrefix(prefix, linePrefix);
}

export function isBlankLineStructuralContinuation(
  prefix: string,
  linePrefix?: string,
): boolean {
  return getBlankLineStructuralAnchor(prefix, linePrefix) !== undefined;
}

function getPreviousNonEmptyLine(prefix: string): string | undefined {
  const lines = prefix.split(/\r?\n/);
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (line.trim()) {
      return line;
    }
  }
  return undefined;
}

function isStructuralContinuationCandidate(line: string): boolean {
  const trimmed = line.trimEnd();
  if (!trimmed) {
    return false;
  }

  if (trimmed.endsWith('\\')) {
    return true;
  }
  if (/\.split\(\s*$/.test(trimmed)) {
    return true;
  }
  if (hasOpenPythonFStringInterpolation(trimmed)) {
    return true;
  }
  if (hasOpenTemplateInterpolation(trimmed)) {
    return true;
  }
  if (isStandaloneBlockOpener(trimmed)) {
    return false;
  }
  if (hasUnclosedParen(trimmed) || hasUnclosedBracketOrBrace(trimmed)) {
    return true;
  }

  return false;
}

function hasOpenPythonFStringInterpolation(linePrefix: string): boolean {
  const lastDouble = linePrefix.lastIndexOf('f"');
  const lastSingle = linePrefix.lastIndexOf("f'");
  const start = Math.max(lastDouble, lastSingle);
  if (start < 0) {
    return false;
  }

  const quote = linePrefix[start + 1];
  const tail = linePrefix.slice(start + 2);
  if (!tail.includes('{')) {
    return false;
  }
  if (tail.includes(quote)) {
    return false;
  }

  return tail.lastIndexOf('{') > tail.lastIndexOf('}');
}

function hasOpenTemplateInterpolation(linePrefix: string): boolean {
  return /`[^`]*\$\{[^}]*$/.test(linePrefix);
}

function hasUnclosedParen(value: string): boolean {
  return countUnclosedGrouping(value, '(', ')') > 0;
}

function hasUnclosedBracketOrBrace(value: string): boolean {
  return countUnclosedGrouping(value, '[', ']') > 0 || countUnclosedGrouping(value, '{', '}') > 0;
}

function isStandaloneBlockOpener(value: string): boolean {
  if (!value.endsWith('{')) {
    return false;
  }
  if (/\b(?:case\b[\s\S]*|default)\s*:\s*\{$/.test(value)) {
    return true;
  }
  if (/[=:(,\[]\s*\{$/.test(value)) {
    return false;
  }

  return /\)\s*\{$/.test(value)
    || /(?:^|\s)(?:class|struct|interface|enum|namespace|module|if|else|for|while|switch|try|catch|finally|do|function|def|func)\b[\s\S]*\{$/.test(value);
}

function countUnclosedGrouping(
  value: string,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escapeNext = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (inSingle) {
      if (char === '\'') {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (char === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inTemplate) {
      if (char === '`') {
        inTemplate = false;
      }
      continue;
    }
    if (char === '\'') {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar && depth > 0) {
      depth -= 1;
    }
  }

  return depth;
}
