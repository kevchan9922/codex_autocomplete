export function normalizeName(rawName: string): string {
  return rawName.trim().split(/\s+/).map((part) => {
    return part[0].toUpperCase() + part.slice(1).toLowerCase();
  }).join(" ");
}

export function wrapPreview(value: string): string {
  return `[${value}]`;
}

export function docPreview(): string {
  const user = normalizeName("  rina patel ");
  const badge = `eng:${user}`;
  // DOC-CURSOR: trigger autocomplete after "(" and document ghost text.
  return wrapPreview(
}
