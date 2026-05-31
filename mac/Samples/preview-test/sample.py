"""A small Python sample to exercise code preview + highlighting."""
from dataclasses import dataclass


@dataclass
class Point:
    x: float
    y: float

    def dist(self) -> float:
        return (self.x ** 2 + self.y ** 2) ** 0.5


if __name__ == "__main__":
    pts = [Point(i, i * 2) for i in range(5)]
    print("总距离:", sum(p.dist() for p in pts))
