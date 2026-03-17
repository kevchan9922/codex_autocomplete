"""Generated Python autocomplete fixtures for gap-fill manual tests."""

from typing import Iterable


def format_status(name: str, active: bool) -> str:
    return f"{name}:{'active' if active else 'inactive'}"


def case_call_completion(user: str) -> str:
    status = format_status(
    return status


def case_suffix_only(values: Iterable[str]) -> str:
    first = next(iter(values), "none")
    return first.up
