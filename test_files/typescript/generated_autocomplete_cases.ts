export function formatStatus(name: string, active: boolean): string {
  return `${name}:${active ? "active" : "inactive"}`;
}

export function caseCallCompletion(user: string): string {
  const status = formatStatus(
  return status;
}

export function caseSuffixOnly(items: string[]): string {
  const first = items[0] ?? "none";
  return first.toLower
}
