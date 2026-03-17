export interface SlidingWindowConfig {
  maxBeforeLines: number;
  maxAfterLines: number;
  maxContextChars: number;
}

export interface SlidingWindowSections {
  beforeLines: string[];
  selection: string;
  afterLines: string[];
}

export interface SlidingWindowResult extends SlidingWindowSections {
  truncated: boolean;
}

export function applySlidingWindow(
  lines: string[],
  cursorLine: number,
  cursorCharacter: number,
  selection: string,
  config: SlidingWindowConfig,
): SlidingWindowResult {
  const safeCursorLine = clamp(cursorLine, 0, lines.length);
  const { beforeAllLines, afterAllLines } = splitAtCursor(lines, safeCursorLine, cursorCharacter);
  const beforeStart = Math.max(0, beforeAllLines.length - config.maxBeforeLines);
  const beforeLines = beforeAllLines.slice(beforeStart);
  const afterLines = afterAllLines.slice(0, config.maxAfterLines);

  return truncateSections(
    {
      beforeLines,
      selection,
      afterLines,
    },
    config.maxContextChars,
  );
}

function splitAtCursor(
  lines: string[],
  cursorLine: number,
  cursorCharacter: number,
): { beforeAllLines: string[]; afterAllLines: string[] } {
  if (cursorLine >= lines.length) {
    return {
      beforeAllLines: [...lines],
      afterAllLines: [],
    };
  }

  const currentLine = lines[cursorLine] ?? '';
  const safeCursorCharacter = clamp(cursorCharacter, 0, currentLine.length);
  const linePrefix = currentLine.slice(0, safeCursorCharacter);
  const lineSuffix = currentLine.slice(safeCursorCharacter);

  const beforeAllLines = [...lines.slice(0, cursorLine)];
  if (linePrefix.length > 0) {
    beforeAllLines.push(linePrefix);
  }

  const afterAllLines = [] as string[];
  if (lineSuffix.length > 0) {
    afterAllLines.push(lineSuffix);
  }
  afterAllLines.push(...lines.slice(cursorLine + 1));

  return { beforeAllLines, afterAllLines };
}

export function truncateSections(
  sections: SlidingWindowSections,
  maxContextChars: number,
): SlidingWindowResult {
  const beforeLines = [...sections.beforeLines];
  const afterLines = [...sections.afterLines];
  let selection = sections.selection;
  let truncated = false;
  let beforeChars = joinedLength(beforeLines);
  let afterChars = joinedLength(afterLines);
  let totalChars = beforeChars + selection.length + afterChars;

  while (totalChars > maxContextChars && beforeLines.length > 0) {
    const hadMultipleLines = beforeLines.length > 1;
    const removed = beforeLines.shift();
    beforeChars -= (removed?.length ?? 0) + (hadMultipleLines ? 1 : 0);
    totalChars = beforeChars + selection.length + afterChars;
    truncated = true;
  }

  if (totalChars > maxContextChars && selection.length > 0) {
    const overflow = totalChars - maxContextChars;
    const removeCount = Math.min(selection.length, overflow);
    selection = selection.slice(removeCount);
    totalChars -= removeCount;
    truncated = true;
  }

  while (totalChars > maxContextChars && afterLines.length > 0) {
    const hadMultipleLines = afterLines.length > 1;
    const removed = afterLines.pop();
    afterChars -= (removed?.length ?? 0) + (hadMultipleLines ? 1 : 0);
    totalChars = beforeChars + selection.length + afterChars;
    truncated = true;
  }

  if (totalChars > maxContextChars) {
    selection = '';
    truncated = true;
  }

  return {
    beforeLines,
    selection,
    afterLines,
    truncated,
  };
}

function joinedLength(lines: string[]): number {
  if (lines.length === 0) {
    return 0;
  }

  let charCount = lines.length - 1;
  for (const line of lines) {
    charCount += line.length;
  }
  return charCount;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
