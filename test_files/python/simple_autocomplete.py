"""Small-file Python autocomplete fixture."""


def format_user(user_id: int, name: str) -> str:
    return f"User(id={user_id}, name={name})"


def greet_user(name: str) -> str:
    return f"Hello, {name}!"


def demo() -> None:
    profile = format_user(7, "Mina")
    print(profile)
    message = greet_user(


def suffix_midline_demo() -> None:
    message2 = greet_user()
    print(message2)


def masked_word_demo() -> str:
    profile = format_user(7, "Mina")
    return profi


if __name__ == "__main__":
    demo()
