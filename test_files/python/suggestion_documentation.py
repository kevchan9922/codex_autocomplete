"""Suggestion documentation fixture for Python manual tests."""


def normalize_name(raw_name: str) -> str:
    return raw_name.strip().title()


def wrap_preview(value: str) -> str:
    return f"[{value}]"


def doc_preview() -> str:
    user = normalize_name("  mina chen ")
    badge = f"eng:{user}"
    # DOC-CURSOR: trigger autocomplete after "(" and document ghost text.
    return wrap_preview(


if __name__ == "__main__":
    print(doc_preview())
