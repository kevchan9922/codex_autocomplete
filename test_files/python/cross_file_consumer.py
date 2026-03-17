"""Cross-file Python fixture for autocomplete benchmark cases."""

from models import User
from utils import greet


def run_cross_file_demo() -> None:
    user = User(user_id=7, name="Mina", role="engineer")
    message = greet(
    print(user.name)
