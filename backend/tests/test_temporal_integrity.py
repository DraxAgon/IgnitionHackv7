"""The methodological rule, tested rather than trusted.

Control selection must never see post-treatment data. That is easy to state, easy
to believe you have implemented, and easy to violate by adding a covariate six
months later. These tests are the thing that actually holds the line.

The strongest of them is `test_post_treatment_data_cannot_change_the_estimate`.
Rather than inspecting the code for leaks, it corrupts the future and checks that
the answer does not move. Any path by which post-cutoff data reaches control
selection or weighting - however indirect, however well hidden - changes the
result and fails the test.
"""

from __future__ import annotations

import dataclasses

import pytest

from app.config import DEFAULT_CONFIG
from app.models.forest_cell import ForestUnit, UnitPool
from app.services import feature_engineering as fe
from app.services.pipeline import run_project_analysis
from app.utils.temporal import (
    PreTreatmentView,
    TemporalLeakError,
    TreatmentTiming,
    Window,
    assert_pre_treatment,
)
from tests.fixtures.synthetic_forest import build_scenario


def _timing(start=2011, pre_start=2003, last=2020, cutoff=None) -> TreatmentTiming:
    return TreatmentTiming(
        start_year=start,
        pre_period=Window(pre_start, start - 1),
        post_period=Window(start, last),
        cutoff_year=cutoff,
    )


# ---- the view refuses to answer questions about the future ----------------

def test_pre_treatment_view_raises_on_post_treatment_year():
    view = PreTreatmentView({y: 1.0 for y in range(2003, 2012)}, Window(2003, 2011), "test")
    assert view.value(2011) == 1.0
    with pytest.raises(TemporalLeakError, match="outside the pre-treatment window"):
        view.value(2012)


def test_pre_treatment_view_vector_stops_at_the_window():
    view = PreTreatmentView({y: float(y) for y in range(2003, 2012)}, Window(2003, 2011), "t")
    assert view.years == tuple(range(2003, 2012))
    assert len(view.vector()) == 9


def test_flux_guard_rejects_treatment_year_and_later():
    timing = _timing()
    assert_pre_treatment([2008, 2009, 2010], timing, "covariate")
    with pytest.raises(TemporalLeakError, match="post-treatment years"):
        assert_pre_treatment([2010, 2011], timing, "covariate")


def test_stock_and_flux_windows_differ_by_one_year():
    """Standing forest on the first day of treatment is pre-treatment information.

    It is determined entirely by clearing in earlier years, and it is the level
    every post-treatment loss is measured against. Excluding it would throw away
    the anchor; including a flux year at or after the start would be a real leak.
    """
    timing = _timing(start=2011, pre_start=2003)
    assert timing.pre_period.end == 2010
    assert timing.pre_stock_window.end == 2011
    assert timing.pre_stock_window.start == timing.pre_period.start


def test_timing_rejects_a_pre_period_overlapping_treatment():
    with pytest.raises(ValueError, match="must end before the project starts"):
        TreatmentTiming(
            start_year=2011,
            pre_period=Window(2003, 2011),
            post_period=Window(2011, 2020),
        )


def test_cutoff_truncates_the_observation_window():
    timing = _timing(cutoff=2015)
    assert timing.effective_post == Window(2011, 2015)
    assert timing.is_backtest is True
    assert _timing().is_backtest is False


def test_cutoff_before_start_is_rejected():
    with pytest.raises(ValueError, match="precedes project start"):
        _timing(cutoff=2009)


# ---- no covariate reads the outcome ---------------------------------------

def test_no_covariate_uses_post_treatment_years():
    """Every registered covariate must be computable from pre-treatment data alone.

    Checked by handing each one a unit whose post-treatment years have been
    replaced with absurd values. A covariate that reads them will produce a
    different number and fail.
    """
    scenario = build_scenario(seed=3)
    timing = _timing()
    unit = scenario.pool.units[0]

    corrupted = dataclasses.replace(
        unit,
        cleared_km2_by_year={
            y: (v if y < timing.start_year else v * 50.0)
            for y, v in unit.cleared_km2_by_year.items()
        },
    )

    for name, spec in fe.registry().items():
        before = spec.compute(unit, timing)
        after = spec.compute(corrupted, timing)
        assert before == after or (before is None and after is None), (
            f"covariate '{name}' changed when post-treatment clearing was altered, "
            f"so it reads the outcome it is meant to predict"
        )


def test_pre_trajectory_excludes_post_treatment_years():
    scenario = build_scenario(seed=3)
    timing = _timing()
    view = fe.extract_pre_trajectory(scenario.pool.units[0], timing)
    assert max(view.years) == timing.start_year
    with pytest.raises(TemporalLeakError):
        view.value(timing.start_year + 1)


# ---- the end-to-end guarantee ---------------------------------------------

def _corrupt_future(pool: UnitPool, cutoff: int, factor: float) -> UnitPool:
    """Multiply every unit's clearing after `cutoff` by `factor`.

    The factor has to be large enough to move any estimate that reads these years
    and small enough to leave the units physically coherent. Too large and the
    corrupted parcels start failing the "cannot clear more forest than you have"
    check, get filtered out of the candidate pool, and the test ends up measuring
    the coherence filter instead of the temporal firewall. The assertion below
    fails loudly if that line is ever crossed, rather than letting the test
    quietly stop testing what it claims to.
    """
    corrupted = UnitPool(
        units=tuple(
            dataclasses.replace(
                u,
                cleared_km2_by_year={
                    y: (v * factor if y > cutoff else v)
                    for y, v in u.cleared_km2_by_year.items()
                },
            )
            for u in pool.units
        ),
        provenance=pool.provenance,
        region=pool.region,
        resolution_note=pool.resolution_note,
    )
    from app.services.forest_service import is_physically_coherent

    incoherent = [u.unit_id for u in corrupted.units if not is_physically_coherent(u)[0]]
    assert not incoherent, (
        f"the corruption factor {factor} pushed {len(incoherent)} units past physical "
        f"coherence, so they would be filtered out and this test would no longer "
        f"exercise the temporal firewall"
    )
    return corrupted


def test_post_treatment_data_cannot_change_the_estimate():
    """Corrupt everything after the cutoff; the answer must not move.

    This is the test that makes the temporal claim credible. It does not inspect
    the code, so it cannot be satisfied by a comment or a well-named variable. If
    any covariate, filter, distance, trajectory score or weight is computed from a
    year after the cutoff, multiplying that year's clearing by 2.5 will move the
    result and this fails.

    Everything at or before the cutoff is left untouched, so an honest pipeline
    is entirely unaffected.
    """
    scenario = build_scenario(seed=5)
    cutoff = 2015
    config = DEFAULT_CONFIG.with_(
        uncertainty=dataclasses.replace(DEFAULT_CONFIG.uncertainty, n_bootstrap=40)
    )

    baseline = run_project_analysis(
        scenario.project, scenario.pool, config=config, cutoff_year=cutoff
    )
    corrupted_pool = _corrupt_future(scenario.pool, cutoff, factor=2.5)
    after = run_project_analysis(
        scenario.project, corrupted_pool, config=config, cutoff_year=cutoff
    )

    assert baseline.fit.control_ids == after.fit.control_ids, "donor selection changed"
    assert baseline.fit.weights.tolist() == pytest.approx(
        after.fit.weights.tolist(), abs=1e-9
    ), "synthetic-control weights changed"
    assert baseline.fit.pre_rmse == pytest.approx(after.fit.pre_rmse, abs=1e-12)
    assert baseline.counterfactual.loss == pytest.approx(
        after.counterfactual.loss, abs=1e-12
    ), "the counterfactual moved, so post-cutoff data reached the estimate"
    assert baseline.risk.score == pytest.approx(after.risk.score, abs=1e-9)


def test_corrupting_data_inside_the_window_does_change_the_estimate():
    """The mirror image, and the reason the test above means anything.

    A test that passes because nothing is connected proves nothing. Corrupting
    data the analysis is *supposed* to see must move the answer - if it does not,
    the previous test would pass on a pipeline that ignores its inputs entirely.
    """
    scenario = build_scenario(seed=5)
    cutoff = 2015
    config = DEFAULT_CONFIG.with_(
        uncertainty=dataclasses.replace(DEFAULT_CONFIG.uncertainty, n_bootstrap=0)
    )

    baseline = run_project_analysis(
        scenario.project, scenario.pool, config=config, cutoff_year=cutoff
    )
    inside = _corrupt_future(scenario.pool, cutoff=2011, factor=2.5)
    after = run_project_analysis(
        scenario.project, inside, config=config, cutoff_year=cutoff
    )

    assert baseline.counterfactual.loss != pytest.approx(after.counterfactual.loss, abs=1e-6)


def test_backtest_cutoff_matches_a_pool_truncated_by_hand():
    """Analysing as of 2016 must equal analysing data that stops in 2016.

    The cutoff is only trustworthy if withholding data and never having it are
    the same thing. Here the future is deleted outright rather than corrupted,
    and the two runs must agree exactly.
    """
    scenario = build_scenario(seed=11)
    cutoff = 2016
    config = DEFAULT_CONFIG.with_(
        uncertainty=dataclasses.replace(DEFAULT_CONFIG.uncertainty, n_bootstrap=0)
    )

    truncated = UnitPool(
        units=tuple(
            dataclasses.replace(
                u,
                cleared_km2_by_year={
                    y: v for y, v in u.cleared_km2_by_year.items() if y <= cutoff
                },
            )
            for u in scenario.pool.units
        ),
        provenance=scenario.pool.provenance,
        region=scenario.pool.region,
    )
    truncated_project = dataclasses.replace(
        scenario.project,
        footprint=dataclasses.replace(
            scenario.project.footprint,
            cleared_km2_by_year={
                y: v
                for y, v in scenario.project.footprint.cleared_km2_by_year.items()
                if y <= cutoff
            },
        ),
    )

    with_cutoff = run_project_analysis(
        scenario.project, scenario.pool, config=config, cutoff_year=cutoff
    )
    without_future = run_project_analysis(truncated_project, truncated, config=config)

    assert with_cutoff.counterfactual.loss == pytest.approx(
        without_future.counterfactual.loss, abs=1e-12
    )
    assert with_cutoff.fit.control_ids == without_future.fit.control_ids
