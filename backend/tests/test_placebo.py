"""Placebo tests: scoring the estimator on land where the answer is known.

A placebo takes an untreated parcel, pretends a project started on it, hides the
future from the matching, and predicts. Because nothing happened to that parcel,
its actual history *is* the true counterfactual, so the prediction can be marked.

These tests check that the harness is honest - that it cannot see the answer, and
that its metrics would notice a broken estimator. The accuracy numbers themselves
are produced by running the suite; they are reported in the notebook rather than
asserted at a fixed value here, because pinning them would turn a measurement
into a target.
"""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from app.config import DEFAULT_CONFIG
from app.services.placebo_testing import (
    PlaceboResult,
    PlaceboSuite,
    run_placebo_suite,
    run_placebo_test,
)
from tests.fixtures.synthetic_forest import build_scenario

FAST = DEFAULT_CONFIG.with_(
    uncertainty=dataclasses.replace(DEFAULT_CONFIG.uncertainty, n_bootstrap=60)
)


def test_a_placebo_predicts_land_that_was_never_treated():
    scenario = build_scenario(seed=7)
    unit = scenario.pool.units[5]
    result = run_placebo_test(unit, scenario.pool, pseudo_start_year=2013, config=FAST)

    assert result.unit_id == unit.unit_id
    assert result.actual_loss >= 0.0
    assert result.error == pytest.approx(result.predicted_loss - result.actual_loss)


def test_a_placebo_cannot_use_itself_as_its_own_control():
    """Otherwise it would reproduce the answer perfectly and prove nothing."""
    from app.services.pipeline import run_project_analysis
    from app.services.placebo_testing import _as_placebo_project

    scenario = build_scenario(seed=7)
    unit = scenario.pool.units[5]
    project = _as_placebo_project(unit, 2013, 8)
    result = run_project_analysis(
        project, scenario.pool.excluding(unit.unit_id), config=FAST, include_bootstrap=False
    )
    assert unit.unit_id not in result.fit.control_ids


def test_placebo_error_is_measured_against_what_actually_happened():
    """The defining property: no treatment occurred, so the observed history is
    the true counterfactual."""
    from app.services.forest_service import loss_fraction

    scenario = build_scenario(seed=7)
    unit = scenario.pool.units[9]
    result = run_placebo_test(unit, scenario.pool, pseudo_start_year=2013, config=FAST)
    expected = loss_fraction(unit, 2013, scenario.last_year)
    assert result.actual_loss == pytest.approx(expected, abs=1e-9)


def test_suite_reports_accuracy_across_many_parcels():
    scenario = build_scenario(seed=7)
    suite = run_placebo_suite(
        scenario.pool,
        pseudo_start_years=[2013],
        config=FAST,
        max_units=12,
        min_forest_km2=100.0,
        include_bootstrap=False,
    )
    metrics = suite.metrics()
    assert metrics["n"] > 0
    for key in ("mae", "rmse", "bias", "median_error", "p90_absolute_error"):
        assert key in metrics
    assert metrics["mae"] >= abs(metrics["bias"]) - 1e-12
    assert metrics["interpretation"]


def test_suite_restricts_itself_to_parcels_that_could_be_controls():
    """Scoring the estimator on land it would never be used on gives a number
    that is true and irrelevant."""
    scenario = build_scenario(seed=7)
    protected_pool = dataclasses.replace(scenario.pool)
    suite = run_placebo_suite(
        protected_pool,
        pseudo_start_years=[2013],
        config=FAST,
        max_units=5,
        min_forest_km2=1e9,  # nothing qualifies
        include_bootstrap=False,
    )
    assert suite.n == 0
    assert suite.metrics()["n"] == 0
    assert "unvalidated" in suite.metrics()["note"]


def test_failures_are_collected_not_raised():
    """A pool where placebos frequently fail is telling us the counterfactuals
    are poorly identified, and that belongs in the report."""
    scenario = build_scenario(seed=7)
    tiny = dataclasses.replace(scenario.pool, units=scenario.pool.units[:4])
    suite = run_placebo_suite(
        tiny, pseudo_start_years=[2013], config=FAST, min_forest_km2=1.0, include_bootstrap=False
    )
    assert suite.failures
    assert all("error" in f and "detail" in f for f in suite.failures)


# ---- the metrics would notice a broken estimator ---------------------------

def _fake(predicted, actual, covered=True) -> PlaceboResult:
    return PlaceboResult(
        unit_id="X",
        pseudo_start_year=2013,
        predicted_loss=predicted,
        actual_loss=actual,
        error=predicted - actual,
        pre_treatment_rmse=0.001,
        effective_controls=5.0,
        interval_lower=predicted - 0.01,
        interval_upper=predicted + 0.01,
        covered=covered,
        confidence="HIGH",
    )


def test_metrics_detect_a_downward_biased_estimator():
    """The failure mode that matters most.

    An estimator biased low understates every counterfactual, which understates
    avoided deforestation, which reports over-crediting on projects that did
    nothing wrong. The interpretation text has to name that consequence rather
    than just reporting a number.
    """
    suite = PlaceboSuite(
        results=tuple(_fake(0.05, 0.09) for _ in range(20)), failures=()
    )
    metrics = suite.metrics()
    assert metrics["bias"] < -0.03
    assert any("low" in line for line in metrics["interpretation"])
    assert any("over-crediting" in line for line in metrics["interpretation"])


def test_metrics_detect_intervals_that_are_too_narrow():
    suite = PlaceboSuite(
        results=tuple(_fake(0.05, 0.05, covered=(i < 5)) for i in range(20)), failures=()
    )
    metrics = suite.metrics()
    assert metrics["interval_coverage"] == pytest.approx(0.25)
    assert any("too narrow" in line for line in metrics["interpretation"])


def test_an_unbiased_estimator_is_reported_as_unbiased():
    rng = np.random.default_rng(1)
    results = tuple(
        _fake(0.05 + float(rng.normal(0, 0.002)), 0.05) for _ in range(50)
    )
    metrics = PlaceboSuite(results=results, failures=()).metrics()
    assert abs(metrics["bias"]) < 0.005
    assert any("no material bias" in line for line in metrics["interpretation"])
