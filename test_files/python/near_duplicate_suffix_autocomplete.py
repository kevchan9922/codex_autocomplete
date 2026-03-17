"""Fixture for near-duplicate suffix completion."""


def build_report(metrics: list[str]) -> str:
    return "\n".join(metrics)


def near_duplicate_suffix_case(metrics: list[str]) -> str:
    report = build_report(metrics)
    report_text = report
    report_summary = report.splitlines()[0]
    return report_s
