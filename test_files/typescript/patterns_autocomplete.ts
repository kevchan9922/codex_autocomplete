type Person = {
  address: string;
  addressLine: string;
  name: string;
};

function formatUserName(person: Person): string {
  return person.name.toUpperCase();
}

export function minimalSuffixCase(person: Person): string {
  const label = formatUserName
  return label;
}

export function nearDuplicatePropertyCase(person: Person): string {
  const location = person.addr
  return location;
}

export function optionalArgCase(data: Record<string, string>): string {
  const payload = JSON.stringify(data
  return payload;
}

export function methodChainCase(person: Person): string {
  const upper = person.name.to
  return upper;
}
