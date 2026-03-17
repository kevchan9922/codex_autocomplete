import { titleCase, welcome } from "./simple_autocomplete";
import { buildPlanningSummary } from "./large_autocomplete";

function runCrossFileDemo(): void {
  const raw = "rEPO quality checks";
  const label = titleCase(raw);
  console.log(label);

  const plan = buildPlanningSummary();
  console.log(plan.split("\n").length);

  const message = welcome(
}

runCrossFileDemo();
