"""Forest measurement arithmetic.

Unglamorous and the most consequential code in the repository. Every headline
figure is a ratio of two numbers produced here, so an off-by-one in the year
convention or a wrong denominator does not announce itself - it just shifts every
project's verdict slightly and consistently.
"""

from __future__ import annotations

import pytest

from app.models.forest_cell import ForestUnit
from app.models.provenance import DataProvenance, Provenance
from app.services import forest_service as fs
from app.utils.temporal import Window

FIXTURE = DataProvenance(kind=Provenance.SYNTHETIC, source="test_loss_calculation")


def unit(cleared: dict[int, float], forest: float = 1000.0, land: float = 1200.0) -> ForestUnit:
    return ForestUnit(
        unit_id="U1",
        centroid=(-60.0, -5.0),
        bbox=(-60.5, -5.5, -59.5, -4.5),
        land_km2=land,
        forest_baseline_km2=forest,
        first_year=min(cleared) if cleared else 2010,
        cleared_km2_by_year=cleared,
        provenance=FIXTURE,
    )


# ---- stock and flux --------------------------------------------------------

def test_forest_at_first_year_is_the_baseline():
    u = unit({2010: 10.0, 2011: 20.0})
    assert fs.forest_km2_at(u, 2010) == 1000.0


def test_stock_is_measured_at_the_start_of_the_year():
    """Clearing in 2010 reduces the stock at the start of 2011, not of 2010.

    The whole loss calculation hinges on this. If the stock at 2010 already
    reflected 2010's clearing, a window opening in 2010 would divide by a
    denominator that had lost a year of forest, overstating every loss rate.
    """
    u = unit({2010: 10.0, 2011: 20.0, 2012: 5.0})
    assert fs.forest_km2_at(u, 2010) == 1000.0
    assert fs.forest_km2_at(u, 2011) == 990.0
    assert fs.forest_km2_at(u, 2012) == 970.0
    assert fs.forest_km2_at(u, 2013) == 965.0


def test_cleared_between_is_inclusive_at_both_ends():
    u = unit({2010: 1.0, 2011: 2.0, 2012: 4.0, 2013: 8.0})
    assert fs.cleared_between(u, 2011, 2012) == 6.0
    assert fs.cleared_between(u, 2010, 2013) == 15.0


def test_stock_and_flux_reconcile():
    """Forest surviving a window equals the stock at its start less the clearing.

    The invariant that keeps the two conventions from drifting apart.
    """
    u = unit({y: 3.0 for y in range(2010, 2020)})
    window = Window(2012, 2016)
    start = fs.forest_km2_at(u, window.start)
    survived = fs.forest_km2_at(u, window.end + 1)
    assert survived == pytest.approx(start - fs.cleared_between(u, window.start, window.end))


def test_forest_cannot_go_negative():
    u = unit({2010: 900.0, 2011: 900.0}, forest=1000.0)
    assert fs.forest_km2_at(u, 2012) == 0.0


# ---- loss fractions --------------------------------------------------------

def test_loss_fraction_uses_forest_at_window_start_as_denominator():
    """Not the original baseline, and not total area.

    A unit that lost half its forest before the window opens should be measured
    against what it still had, or its later losses read as smaller than they were.
    """
    u = unit({2010: 500.0, 2011: 100.0, 2012: 150.0}, forest=1000.0, land=1200.0)
    # Standing at the start of 2011 is 500; 250 cleared over 2011-2012.
    assert fs.loss_fraction(u, 2011, 2012) == pytest.approx(0.5)


def test_loss_fraction_is_not_a_share_of_total_area():
    """Non-forest land in the boundary must not dilute the loss rate."""
    forested = unit({2011: 100.0}, forest=1000.0, land=1000.0)
    half_savanna = unit({2011: 100.0}, forest=1000.0, land=2000.0)
    assert fs.loss_fraction(forested, 2011, 2011) == pytest.approx(0.1)
    assert fs.loss_fraction(half_savanna, 2011, 2011) == pytest.approx(0.1)


def test_loss_fraction_of_a_unit_with_no_forest_is_zero_not_an_error():
    u = unit({2011: 0.0}, forest=0.0, land=100.0)
    assert fs.loss_fraction(u, 2011, 2011) == 0.0


def test_calculate_loss_matches_the_worked_example():
    """Stage 12: synthetic cover 96.8% falling to 86.0% is an 11.2% loss."""
    assert fs.calculate_loss(0.968, 0.860) == pytest.approx(0.1116, abs=1e-4)


def test_calculate_loss_is_relative_to_the_starting_level():
    assert fs.calculate_loss(1.0, 0.9) == pytest.approx(0.1)
    assert fs.calculate_loss(0.5, 0.45) == pytest.approx(0.1)


# ---- trajectories ----------------------------------------------------------

def test_remaining_series_is_anchored_at_one():
    u = unit({y: 10.0 for y in range(2010, 2020)})
    series = fs.remaining_fraction_series(u, Window(2012, 2016))
    assert series[2012] == pytest.approx(1.0)
    assert series[2016] < series[2012]


def test_remaining_series_makes_units_of_different_size_comparable():
    """A 1,000 km2 parcel and a 100 km2 parcel losing 1% both read as 0.99."""
    big = unit({2010: 10.0}, forest=1000.0, land=1000.0)
    small = unit({2010: 1.0}, forest=100.0, land=100.0)
    w = Window(2010, 2011)
    assert fs.remaining_fraction_series(big, w)[2011] == pytest.approx(
        fs.remaining_fraction_series(small, w)[2011]
    )


def test_annual_path_accumulates():
    u = unit({2011: 10.0, 2012: 10.0, 2013: 10.0}, forest=1000.0)
    path = fs.annual_loss_path(u, Window(2011, 2013))
    assert [round(r["loss"], 3) for r in path] == [0.01, 0.02, 0.03]
    assert path[-1]["forest_remaining"] == pytest.approx(0.97)


def test_historical_loss_trend_sign_follows_the_direction_of_pressure():
    rising = unit({2010: 1.0, 2011: 2.0, 2012: 3.0, 2013: 4.0}, forest=1000.0)
    easing = unit({2010: 4.0, 2011: 3.0, 2012: 2.0, 2013: 1.0}, forest=1000.0)
    window = Window(2010, 2013)
    assert fs.historical_loss_trend(rising, window) > 0
    assert fs.historical_loss_trend(easing, window) < 0


def test_trend_separates_units_with_identical_average_clearing():
    """The reason the trend covariate exists at all."""
    rising = unit({2010: 1.0, 2011: 2.0, 2012: 3.0, 2013: 4.0}, forest=1000.0)
    easing = unit({2010: 4.0, 2011: 3.0, 2012: 2.0, 2013: 1.0}, forest=1000.0)
    window = Window(2010, 2013)
    assert fs.historical_loss_rate(rising, window) == pytest.approx(
        fs.historical_loss_rate(easing, window)
    )
    assert fs.historical_loss_trend(rising, window) != pytest.approx(
        fs.historical_loss_trend(easing, window)
    )


# ---- data adequacy ---------------------------------------------------------

def test_a_missing_year_is_not_a_quiet_zero():
    u = unit({2010: 1.0, 2012: 1.0})
    assert fs.has_complete_history(u, Window(2010, 2012)) is False
    assert fs.has_complete_history(u, Window(2010, 2010)) is True


def test_coherence_rejects_clearing_beyond_available_forest():
    u = unit({2010: 800.0, 2011: 800.0}, forest=1000.0)
    ok, reason = fs.is_physically_coherent(u)
    assert ok is False
    assert "exceeds" in reason


def test_coherence_rejects_negative_clearing():
    u = unit({2010: 5.0, 2011: -3.0}, forest=1000.0)
    ok, reason = fs.is_physically_coherent(u)
    assert ok is False
    assert "negative" in reason


def test_coherence_rejects_a_unit_with_no_forest():
    """The artefact that made two real project footprints unanalysable.

    A bounding-box area sum can subtract more previously cleared land than the
    footprint contains, leaving a zero forest baseline. Every ratio then returns
    0.0, which reads as a perfectly protected forest rather than a broken
    denominator - the most dangerous direction for this error to point.
    """
    u = unit({2010: 0.0}, forest=0.0, land=1000.0)
    ok, reason = fs.is_physically_coherent(u)
    assert ok is False
    assert "no forest" in reason


def test_project_loss_reports_the_disturbance_caveat():
    """Canopy loss is not the same thing as deforestation, and the number says so."""
    u = unit({y: 10.0 for y in range(2011, 2019)}, forest=1000.0)
    result = fs.calculate_actual_project_loss(u, Window(2011, 2018))
    assert result["loss_fraction"] == pytest.approx(0.08)
    assert result["cleared_ha"] == pytest.approx(8000.0)
    assert "upper bound" in result["disturbance_caveat"]


def test_hectare_conversion_is_not_fumbled():
    u = unit({2011: 1.0}, forest=100.0, land=100.0)
    area = fs.initial_forest_area(u, 2011)
    assert area["forest_km2"] == pytest.approx(100.0)
    assert area["forest_ha"] == pytest.approx(10_000.0)
