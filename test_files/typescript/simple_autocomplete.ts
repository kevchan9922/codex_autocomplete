export function titleCase(input: string): string {
  return input
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function welcome(name: string): string {
  return `Welcome, ${name}!`;
}

function runDemo(): void {
  const normalized = titleCase("sAm lee");
  console.log(normalized);

  const message = welcome(
}

function suffixMidlineDemo(): void {
  const normalized = titleCase("sAm lee");
  const suffixMessage = welcome();
  console.log(suffixMessage);
}

function maskedWordDemo(): string {
  const normalized = titleCase("sAm lee");
  return normaliz;
}

runDemo();
