"""Larger Python fixture with repeated domain helpers for context window testing."""

from dataclasses import dataclass
from statistics import mean


@dataclass
class DailyMetric:
    day: str
    signups: int
    activations: int
    retained_users: int


METRICS: list[DailyMetric] = [
    DailyMetric("2024-06-01", 120, 73, 60),
    DailyMetric("2024-06-02", 133, 81, 63),
    DailyMetric("2024-06-03", 98, 61, 50),
    DailyMetric("2024-06-04", 145, 90, 71),
    DailyMetric("2024-06-05", 160, 101, 83),
    DailyMetric("2024-06-06", 140, 87, 72),
    DailyMetric("2024-06-07", 170, 110, 91),
]


def activation_rate(metric: DailyMetric) -> float:
    if metric.signups == 0:
        return 0.0
    return metric.activations / metric.signups


def retention_rate(metric: DailyMetric) -> float:
    if metric.activations == 0:
        return 0.0
    return metric.retained_users / metric.activations


def summarize_day(metric: DailyMetric) -> str:
    return (
        f"{metric.day}: signups={metric.signups}, "
        f"activation_rate={activation_rate(metric):.2%}, "
        f"retention_rate={retention_rate(metric):.2%}"
    )


def weekly_activation_average(metrics: list[DailyMetric]) -> float:
    return mean(activation_rate(item) for item in metrics)


def weekly_retention_average(metrics: list[DailyMetric]) -> float:
    return mean(retention_rate(item) for item in metrics)


def build_report(metrics: list[DailyMetric]) -> str:
    lines = ["Weekly KPI report", "-----------------"]
    for metric in metrics:
        lines.append(summarize_day(metric))

    lines.append("")
    lines.append(f"Activation avg: {weekly_activation_average(metrics):.2%}")
    lines.append(f"Retention avg: {weekly_retention_average(metrics):.2%}")
    return "\n".join(lines)


def demo_large_context() -> str:
    report = build_report(METRICS)
    print(report)
    return report


def quick_check() -> str:
    text = build_report(METRICS)
    return text.splitlines(


def near_duplicate_report_pick() -> str:
    report = build_report(METRICS)
    report_text = report
    report_summary = report.splitlines()[0]
    return report_


if __name__ == "__main__":
    demo_large_context()
