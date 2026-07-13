"""Shared data fixtures for the split SamQL test suites."""
import csv
import json

ROWS = 60


def make_csv(path):
    categories = ["alpha", "beta", "gamma"]
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["id", "name", "score", "category", "dt"])
        for index in range(ROWS):
            writer.writerow([index, f"name_{index}", round(index * 1.5, 2),
                             categories[index % 3],
                             f"2024-01-{(index % 28) + 1:02d}"])


def make_json(path):
    data = [
        {"id": 1, "user": {"name": "Ada", "age": 36},
         "tags": ["x", "y"], "active": True},
        {"id": 2, "user": {"name": "Linus", "age": 54},
         "tags": ["z"], "active": False},
    ]
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
