"""Temporal integrity: the rule that makes the whole comparison honest.

A carbon project's baseline is checked by finding land that looked like it
*before* the project started, then watching what that land did afterwards. The
moment anything about the post-treatment years leaks into the choice of control
land, the comparison stops being a test and becomes a circular restatement of
the answer.

Discipline does not enforce this. A comment saying "only use pre-treatment data"
is not a constraint; it is a hope. So the pre-treatment period is handed to the
matching and weighting code as a `PreTreatmentView` — an object that physically
cannot return a post-cutoff year and raises `TemporalLeakError` if asked. The
post-treatment data is not passed to those functions at all.

Weights are then frozen into an immutable object before any post-treatment
series is touched.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence


class TemporalLeakError(RuntimeError):
    """Raised when code inside the pre-treatment stage reaches for the future.

    This is a bug, never a condition to handle. If it fires, a covariate,
    a matcher or an optimiser is reading the outcome it is supposed to predict.
    """


@dataclass(frozen=True)
class Window:
    """An inclusive span of years."""

    start: int
    end: int

    def __post_init__(self) -> None:
        if self.end < self.start:
            raise ValueError(f"window ends ({self.end}) before it starts ({self.start})")

    @property
    def years(self) -> tuple[int, ...]:
        return tuple(range(self.start, self.end + 1))

    @property
    def length(self) -> int:
        return self.end - self.start + 1

    def contains(self, year: int) -> bool:
        return self.start <= year <= self.end

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Window({self.start}–{self.end})"


@dataclass(frozen=True)
class TreatmentTiming:
    """When a project starts, and which years may be used for what.

    `cutoff_year` is the analysis-as-of date and is what backtesting moves.
    Setting it to 2018 makes the engine behave as though 2019 onward had not
    been observed yet, which is how we ask "what would this have said in 2018?"
    without quietly using data that did not exist then.
    """

    start_year: int
    pre_period: Window
    post_period: Window
    cutoff_year: int | None = None

    def __post_init__(self) -> None:
        if self.pre_period.end >= self.start_year:
            raise ValueError(
                f"pre-treatment period must end before the project starts "
                f"({self.pre_period.end} >= {self.start_year})"
            )
        if self.post_period.start < self.start_year:
            raise ValueError(
                f"post-treatment period must begin at or after the project starts "
                f"({self.post_period.start} < {self.start_year})"
            )
        if self.cutoff_year is not None and self.cutoff_year < self.start_year:
            raise ValueError(
                f"cutoff {self.cutoff_year} precedes project start {self.start_year}; "
                "there would be no outcome to observe"
            )

    @property
    def pre_stock_window(self) -> Window:
        """Pre-treatment years indexed by *standing forest*, not by clearing.

        The distinction matters and is easy to get wrong. Clearing is a flow
        recorded against the year it happened in; standing forest is a stock
        measured at an instant. Forest standing at the *start* of the project's
        first year is fixed entirely by clearing in earlier years, so it is
        pre-treatment information even though it carries the start year's label.

        It is also the single most useful point in the series: it is the level
        the post-treatment loss is measured against. Excluding it because of its
        label would throw away the anchor; including a *flux* year at or after
        the start would be a genuine leak. So stock windows run to `start_year`
        inclusive and flux windows stop at `start_year - 1`, and the two are
        given different names to stop anyone conflating them.
        """
        return Window(self.pre_period.start, self.start_year)

    @property
    def effective_post(self) -> Window:
        """The post-treatment years this analysis is allowed to observe.

        Without a cutoff this is the full post period. With one it is truncated,
        which is the entire mechanism behind historical backtesting.
        """
        if self.cutoff_year is None:
            return self.post_period
        return Window(self.post_period.start, min(self.post_period.end, self.cutoff_year))

    @property
    def is_backtest(self) -> bool:
        return self.cutoff_year is not None and self.cutoff_year < self.post_period.end


class PreTreatmentView:
    """A read-only window onto a year-indexed series, closed at the cutoff.

    Anything that selects or weights controls receives one of these instead of
    the raw series. Asking for a year at or after the treatment start is a
    programming error and raises rather than returning a value.
    """

    __slots__ = ("_series", "_window", "_label")

    def __init__(self, series: Mapping[int, float], window: Window, label: str = "series"):
        self._series = dict(series)
        self._window = window
        self._label = label

    @property
    def window(self) -> Window:
        return self._window

    @property
    def years(self) -> tuple[int, ...]:
        return self._window.years

    def value(self, year: int) -> float:
        if not self._window.contains(year):
            raise TemporalLeakError(
                f"{self._label}: year {year} lies outside the pre-treatment window "
                f"{self._window.start}–{self._window.end}. Selecting or weighting "
                f"controls on it would leak the outcome into the comparison."
            )
        return self._series[year]

    def vector(self) -> tuple[float, ...]:
        return tuple(self._series[y] for y in self.years)

    def __len__(self) -> int:
        return self._window.length

    def __iter__(self) -> Iterable[tuple[int, float]]:
        return iter((y, self._series[y]) for y in self.years)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"PreTreatmentView({self._label}, {self._window!r})"


def assert_pre_treatment(years: Sequence[int], timing: TreatmentTiming, what: str) -> None:
    """Guard for code paths that take plain year lists rather than a view.

    Enforces the *flux* convention: these are years in which clearing happened,
    so anything at or after the start year is post-treatment. Do not use this on
    stock years - see `TreatmentTiming.pre_stock_window`.
    """
    offenders = [y for y in years if y >= timing.start_year]
    if offenders:
        raise TemporalLeakError(
            f"{what} was given post-treatment years {offenders} for a project starting "
            f"{timing.start_year}. Control selection must not see them."
        )
