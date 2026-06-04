#!/usr/bin/env python3
"""Python 脚本模板。"""

from dataclasses import dataclass
from typing import Iterable


@dataclass
class Task:
    title: str
    done: bool = False


def pending(tasks: Iterable[Task]) -> list[Task]:
    """返回所有未完成的任务。"""
    return [t for t in tasks if not t.done]


def main() -> None:
    tasks = [
        Task("写文档", done=True),
        Task("写代码"),
        Task("测试"),
    ]
    for task in pending(tasks):
        print(f"待办: {task.title}")


if __name__ == "__main__":
    main()
