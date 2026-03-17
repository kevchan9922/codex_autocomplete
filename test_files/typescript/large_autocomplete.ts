type Ticket = {
  id: string;
  priority: "P0" | "P1" | "P2";
  title: string;
  assignee: string;
  storyPoints: number;
  completed: boolean;
};

const backlog: Ticket[] = [
  { id: "ENG-101", priority: "P0", title: "Fix auth callback", assignee: "Ari", storyPoints: 5, completed: true },
  { id: "ENG-102", priority: "P1", title: "Improve completion debounce", assignee: "Sia", storyPoints: 3, completed: false },
  { id: "ENG-103", priority: "P2", title: "Add debug command", assignee: "Kai", storyPoints: 2, completed: true },
  { id: "ENG-104", priority: "P1", title: "Refactor token cache", assignee: "Ari", storyPoints: 8, completed: false },
  { id: "ENG-105", priority: "P0", title: "Handle stale responses", assignee: "Mia", storyPoints: 5, completed: true },
  { id: "ENG-106", priority: "P2", title: "Docs for manual tests", assignee: "Sia", storyPoints: 1, completed: false },
];

function byPriority(priority: Ticket["priority"]): Ticket[] {
  return backlog.filter((ticket) => ticket.priority === priority);
}

function completedPoints(tickets: Ticket[]): number {
  return tickets.filter((ticket) => ticket.completed).reduce((sum, ticket) => sum + ticket.storyPoints, 0);
}

function openPoints(tickets: Ticket[]): number {
  return tickets.filter((ticket) => !ticket.completed).reduce((sum, ticket) => sum + ticket.storyPoints, 0);
}

function summarizePriority(priority: Ticket["priority"]): string {
  const subset = byPriority(priority);
  return `${priority}: done=${completedPoints(subset)}, open=${openPoints(subset)}`;
}

export function buildPlanningSummary(): string {
  const lines = ["Sprint planning snapshot", "------------------------"];
  lines.push(summarizePriority("P0"));
  lines.push(summarizePriority("P1"));
  lines.push(summarizePriority("P2"));
  return lines.join("\n");
}

export function p1Snapshot(): string {
  return summarizePriority(
}

export function nearDuplicateOpenPoints(): number {
  const open = byPriority("P1");
  const openPointsTotal = openPoints(open);
  const openPointsByPriority = (priority: Ticket["priority"]): number =>
    openPoints(byPriority(priority));
  return openPointsByPriority(
}

console.log(buildPlanningSummary());
