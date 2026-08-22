"""Forest measurement: turning annual clearing records into the quantities the
analysis actually compares.

This module knows about forest. It does not know where the forest data came
from - that is the adapters' job - and it does not know anything about carbon
projects, matching or counterfactuals. Everything here is arithmetic over an
observed series, and it is kept separate precisely so that a change of data
provider cannot quietly change the definition of "loss".

Two conventions, held to everywhere:

  Flux years   Clearing is recorded against the year it happened in.
               cleared_between(2016, 2023) is eight years of clearing.

  Stock years  Standing forest is measured at the *start* of a year.
               forest_km2_at(2016) is what was standing on 1 January 2016,
               which is fixed by clearing in 2015 and earlier.

So loss over the window 2016-2023 is clearing in 2016..2023 divided by the stock
at the start of 2016, and the stock that survives it is the stock at the start of
2024. Mixing the two conventions is the classic off-by-one in this domain, and it
biases every loss rate by a year of clearing.
"""

from __future__ import annotations

import numpy as np

from ..models.forest_cell import ForestUnit
from ..utils.stats import ols_slope, safe_divide
from ..utils.temporal import Window


# ---- stock and flux -------------------------------------------------------

def forest_km2_at(unit: ForestUnit, year: int) -> float:
    """Forest standing at the START of `year`, in km2.

    Derived by subtracting recorded clearing from the baseline stock rather than
    read from a separate stock layer, so the series cannot contradict itself.
    Clamped at zero: a unit cannot lose more forest than it had, and floating
    point over independently rounded layers can otherwise produce a small
    negative that becomes a nonsensical loss rate downstream.
    """
    standing = unit.forest_baseline_km2
    for y in range(unit.first_year, year):
        standing -= unit.cleared_km2_by_year.get(y, 0.0)
    return max(0.0, standing)


def cleared_between(unit: ForestUnit, first_year: int, last_year: int) -> float:
    """Forest cleared during the inclusive flux window, in km2."""
    return sum(
        unit.cleared_km2_by_year.get(y, 0.0) for y in range(first_year, last_year + 1)
    )


def loss_fraction(unit: ForestUnit, first_year: int, last_year: int) -> float:
    """Share of the forest standing at the start of the window that was cleared.

    The denominator is initial *forest* area, never total unit area. A project
    that is half savanna would otherwise report half the loss rate of an
    identical all-forest project, purely from the non-forest land inside its
    boundary.
    """
    base = forest_km2_at(unit, first_year)
    return safe_divide(cleared_between(unit, first_year, last_year), base, default=0.0)


def calculate_loss(start_cover: float, end_cover: float) -> float:
    """Loss between two cover levels, as a fraction of the starting level.

    The general form used wherever two trajectory points are compared - the
    project's own series, the synthetic control's, or a placebo's. Kept as a
    named function because the alternative reading, dividing by cover at the
    *original* anchor rather than at window start, is a different quantity and
    the two are easy to swap by accident.
    """
    return safe_divide(start_cover - end_cover, start_cover, default=0.0)


# ---- trajectories ---------------------------------------------------------

def remaining_fraction_series(
    unit: ForestUnit, window: Window, anchor_year: int | None = None
) -> dict[int, float]:
    """Standing forest through a window, as a fraction of the anchor year's stock.

    Indexed by stock year: the value at 2016 is what stood on 1 January 2016.
    The anchor defaults to the window start, so the first value is exactly 1.0
    and every later value reads directly as "share of the forest we started with
    that is still standing".

    Normalising this way is what makes units of wildly different size
    comparable: a 12,000 km2 parcel and a 600 km2 project footprint both start
    at 1.0, and the synthetic control can then mix them without one drowning
    out the others by sheer size.
    """
    anchor = window.start if anchor_year is None else anchor_year
    base = forest_km2_at(unit, anchor)
    if base <= 0:
        return {y: 0.0 for y in window.years}
    return {y: forest_km2_at(unit, y) / base for y in window.years}


def remaining_fraction_vector(
    unit: ForestUnit, window: Window, anchor_year: int | None = None
) -> np.ndarray:
    series = remaining_fraction_series(unit, window, anchor_year)
    return np.array([series[y] for y in window.years], dtype=float)


def annual_loss_path(unit: ForestUnit, window: Window) -> list[dict]:
    """Cumulative loss for each year of a flux window.

    Returned per year rather than as one end-of-window number because the shape
    carries information the total hides: comparable land that cleared steadily
    is a different case from land that lost everything in a single year of fire,
    and only the annual series can tell them apart.
    """
    base = forest_km2_at(unit, window.start)
    out: list[dict] = []
    running = 0.0
    for year in window.years:
        running += unit.cleared_km2_by_year.get(year, 0.0)
        out.append(
            {
                "year": year,
                "cleared_km2": round(running, 4),
                "loss": safe_divide(running, base, default=0.0),
                "forest_remaining": safe_divide(base - running, base, default=0.0),
            }
        )
    return out


def historical_loss_rate(unit: ForestUnit, window: Window) -> float:
    """Mean annual loss rate over a window, as a fraction of starting forest."""
    return loss_fraction(unit, window.start, window.end) / max(window.length, 1)


def historical_loss_trend(unit: ForestUnit, window: Window) -> float:
    """Whether clearing was accelerating or easing, as a per-year slope.

    Fitted on the annual loss *rate*, so the units are fraction-of-forest per
    year, per year. Negative means the pressure was coming off. This separates
    two parcels with identical average clearing where one was winding down and
    the other was just getting started - exactly the distinction that a baseline
    projected forward from history depends on, and exactly the one an average
    erases.
    """
    base = forest_km2_at(unit, window.start)
    if base <= 0:
        return 0.0
    rates = np.array(
        [unit.cleared_km2_by_year.get(y, 0.0) / base for y in window.years], dtype=float
    )
    return ols_slope(rates)


# ---- data adequacy --------------------------------------------------------

def has_complete_history(unit: ForestUnit, window: Window) -> bool:
    """Whether every year in the window was actually observed.

    A gap is not a zero. A unit missing 2013 has an unknown 2013, and scoring
    that as a year of no clearing makes it look like stable forest - the single
    most flattering error a control can carry, because it drags the
    counterfactual down and makes every project compared against it look better
    than it was.
    """
    return all(y in unit.cleared_km2_by_year for y in window.years)


def is_physically_coherent(unit: ForestUnit, window: Window | None = None) -> tuple[bool, str]:
    """Sanity-check a unit's series before it is allowed into an analysis.

    Returns (ok, reason). These invariants catch a mis-parsed adapter far more
    reliably than eyeballing numbers: forest cannot grow (the records are
    clearing increments, not net change), and cumulative clearing cannot exceed
    the forest that existed to be cleared.
    """
    if unit.forest_baseline_km2 <= 0:
        return False, "no forest at baseline"
    if any(v < -1e-9 for v in unit.cleared_km2_by_year.values()):
        return False, "negative clearing recorded"
    total = cleared_between(unit, unit.first_year, unit.last_year)
    if total > unit.forest_baseline_km2 * 1.01 + 1.0:
        return False, (
            f"cleared {total:.1f} km2 exceeds baseline forest "
            f"{unit.forest_baseline_km2:.1f} km2"
        )
    previous = float("inf")
    for year in range(unit.first_year, unit.last_year + 2):
        standing = forest_km2_at(unit, year)
        if standing > previous + 1e-6:
            return False, f"standing forest increased in {year}"
        previous = standing
    return True, ""


# ---- the treated unit -----------------------------------------------------

def calculate_actual_project_loss(unit: ForestUnit, window: Window) -> dict:
    """Observed forest loss inside a project over the crediting window.

    The one number in the whole comparison that is neither claimed nor modelled:
    what a satellite recorded on the project's own boundary.

    A caveat that belongs with the number rather than in a footnote. Annual
    clearing products detect canopy removal, which includes fire, storm damage
    and commercial harvest alongside permanent conversion. Only permanent
    conversion is relevant to an avoided-deforestation claim. Where a source
    distinguishes them the adapter should carry the distinction through; where it
    does not, this figure is an upper bound on true deforestation, and the
    caveat travels with it rather than leaving a reader to assume otherwise.
    """
    initial = forest_km2_at(unit, window.start)
    cleared = cleared_between(unit, window.start, window.end)
    return {
        "initial_forest_km2": round(initial, 3),
        "initial_forest_ha": round(initial * 100.0, 1),
        "cleared_km2": round(cleared, 3),
        "cleared_ha": round(cleared * 100.0, 1),
        "loss_fraction": loss_fraction(unit, window.start, window.end),
        "annual": annual_loss_path(unit, window),
        "disturbance_caveat": (
            "Measured as canopy loss. Unless the source separates permanent conversion "
            "from fire, harvest and temporary disturbance, this is an upper bound on "
            "deforestation."
        ),
    }


def initial_forest_area(unit: ForestUnit, year: int) -> dict:
    """Stage 2: the denominator, stated explicitly.

    Reported as its own object because every percentage in the analysis is taken
    against it, so a reader who disagrees with the denominator can discount the
    rest without having to reverse-engineer it.
    """
    forest = forest_km2_at(unit, year)
    return {
        "as_of_year": year,
        "total_area_km2": round(unit.land_km2, 3),
        "total_area_ha": round(unit.land_km2 * 100.0, 1),
        "forest_km2": round(forest, 3),
        "forest_ha": round(forest * 100.0, 1),
        "forest_share_of_area": safe_divide(forest, unit.land_km2, default=0.0),
    }
