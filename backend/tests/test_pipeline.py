"""End to end: does the whole thing recover a counterfactual it cannot see?

Every other test checks a component. These check the claim the product makes.
The fixture constructs a world where the true counterfactual is known, hides it,
and asks the pipeline to find it.

The accuracy assertions here are the ones that caught a real bug. An earlier
version measured the counterfactual over a stock window ending at the last year
of clearing rather than one year past it, so the counterfactual counted N-1 years
of loss against the project's N. Every project came out looking more
over-credited than it was, by about one year in N, and nothing else in the suite
noticed - the pre-treatment fit was excellent and every component behaved. Only
scoring the finished estimate against a known truth exposed it.
"""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from app.config import DEFAULT_CONFIG
from app.services.counterfactual import (
    calculate_claimed_avoided_loss,
    calculate_impact,
    calculate_independent_avoided_loss,
    calculate_potential_overcrediting,
)
from app.services.pipeline import ProjectDataError, run_backtest_series, run_project_analysis
from tests.fixtures.synthetic_forest import build_scenario

FAST = DEFAULT_CONFIG.with_(
    uncertainty=dataclasses.replace(DEFAULT_CONFIG.uncertainty, n_bootstrap=120)
)


# ---- recovering a known truth ---------------------------------------------

def test_recovers_the_true_counterfactual():
    scenario = build_scenario(seed=7)
    result = run_project_analysis(scenario.project, scenario.pool, config=FAST)

    error = result.counterfactual.loss - scenario.true_counterfactual_loss
    assert abs(error) < 0.005, (
        f"estimated counterfactual {result.counterfactual.loss:.4f} against a true "
        f"{scenario.true_counterfactual_loss:.4f}"
    )
    relative = result.counterfactual.loss / scenario.true_counterfactual_loss
    assert 0.9 < relative < 1.1


def test_observed_project_loss_is_measured_not_estimated():
    """The one number that should come back exactly right."""
    scenario = build_scenario(seed=7)
    result = run_project_analysis(scenario.project, scenario.pool, config=FAST)
    assert float(result.observed["loss_fraction"]) == pytest.approx(
        scenario.true_actual_loss, abs=1e-9
    )


def test_recovers_the_true_avoided_deforestation():
    scenario = build_scenario(seed=7)
    result = run_project_analysis(scenario.project, scenario.pool, config=FAST)
    assert result.impact.estimated_avoided == pytest.approx(
        scenario.true_avoided, abs=0.006
    )


def test_estimator_is_not_systematically_biased():
    """The property that matters most for crediting.

    A counterfactual estimator biased low understates avoided deforestation on
    every project it touches, and would report over-crediting even where there is
    none. Measured across independent generated worlds rather than asserted.

    The residual bias is small and negative by construction: the fixture drives
    each unit by compounding a blended clearing *rate*, while a synthetic control
    averages donor *levels*. Those differ by a Jensen gap, so the truth sits
    slightly outside the model class. That is deliberate - a fixture generated
    exactly the way the estimator models the world would make this test
    self-fulfilling.
    """
    errors = []
    for seed in range(1, 11):
        scenario = build_scenario(seed=seed)
        result = run_project_analysis(
            scenario.project, scenario.pool, config=FAST, include_bootstrap=False
        )
        errors.append(result.counterfactual.loss - scenario.true_counterfactual_loss)

    errors = np.array(errors)
    assert abs(errors.mean()) < 0.002, (
        f"mean signed error {errors.mean():+.5f} of forest cover indicates a "
        f"systematic bias in the counterfactual"
    )
    assert np.abs(errors).mean() < 0.003


def test_confidence_interval_covers_the_truth_most_of_the_time():
    """Coverage near the nominal level, measured.

    Some shortfall is expected and is documented rather than tuned away: the
    bootstrap resamples donors, so it captures sensitivity to which parcels were
    available and nothing else. Weight non-uniqueness and model specification are
    real sources of error it cannot see, which is why the threshold here sits
    below 95% and why `uncertainty.describe()` says the interval is a lower bound
    on total uncertainty.
    """
    covered = []
    for seed in range(1, 11):
        scenario = build_scenario(seed=seed)
        result = run_project_analysis(scenario.project, scenario.pool, config=FAST)
        covered.append(
            result.interval.lower <= scenario.true_counterfactual_loss <= result.interval.upper
        )
    assert np.mean(covered) >= 0.7, f"coverage {np.mean(covered):.0%} is far below nominal 95%"


def test_counterfactual_and_project_loss_span_the_same_number_of_years():
    """Guards the off-by-one directly.

    Both sides of the comparison must count the same years of clearing. When they
    did not, the counterfactual was short by one year in N and every project read
    as more over-credited than it was.
    """
    scenario = build_scenario(seed=4)
    result = run_project_analysis(
        scenario.project, scenario.pool, config=FAST, include_bootstrap=False
    )
    observation = result.timing.effective_post
    assert len(result.observed["annual"]) == observation.length
    assert len(result.counterfactual.annual) == observation.length + 1
    assert result.counterfactual.window.start == observation.start
    assert result.counterfactual.window.end == observation.end + 1


# ---- the comparison arithmetic ---------------------------------------------

def test_worked_example_from_the_brief():
    """Counterfactual 11.2%, project 4%, claimed baseline 35%."""
    impact = calculate_impact(
        counterfactual_loss=0.112, actual_loss=0.04, claimed_baseline=0.35
    )
    assert impact.estimated_avoided == pytest.approx(0.072, abs=1e-9)
    assert impact.claimed_avoided == pytest.approx(0.31, abs=1e-9)
    assert impact.supported_fraction == pytest.approx(0.2323, abs=1e-4)
    assert impact.potential_overcrediting == pytest.approx(0.7677, abs=1e-4)
    assert impact.baseline_difference == pytest.approx(0.238, abs=1e-9)


def test_avoided_loss_is_floored_at_zero():
    """A project that lost more than its counterfactual has not avoided a negative
    amount of deforestation."""
    assert calculate_independent_avoided_loss(0.05, 0.20) == 0.0
    assert calculate_claimed_avoided_loss(0.05, 0.20) == 0.0


def test_supported_fraction_is_undefined_when_nothing_was_claimed():
    """Not zero. Zero would read as "none of the claim is supported", which is a
    finding; the honest answer is that there is no claim to apportion."""
    supported, over = calculate_potential_overcrediting(0.0, 0.05)
    assert supported is None and over is None


def test_supported_fraction_is_capped_at_one():
    """A conservative baseline does not mean 140% of credits are supported."""
    supported, over = calculate_potential_overcrediting(0.05, 0.20)
    assert supported == 1.0
    assert over == 0.0


def test_a_conservative_baseline_is_not_scored_as_a_risk():
    """A baseline below what comparable land did must come back clean.

    The claim has to sit above the project's own observed loss, or it claims no
    avoided deforestation at all and there is nothing to apportion - a different
    case, covered by `test_supported_fraction_is_undefined_when_nothing_was_
    claimed`. Here the project observes about 2.2% loss against a counterfactual
    near 5.2%, so a 3% baseline is genuinely conservative.
    """
    scenario = build_scenario(seed=7, claimed_baseline=0.03)
    result = run_project_analysis(scenario.project, scenario.pool, config=FAST)
    assert result.impact.claimed_avoided > 0
    assert result.impact.supported_fraction == 1.0
    assert result.impact.potential_overcrediting == 0.0
    assert result.risk.score < 30
    assert result.risk.level in ("CONSISTENT", "MODERATE")


def test_an_inflated_baseline_is_scored_as_a_risk():
    scenario = build_scenario(seed=7, claimed_baseline=0.60)
    result = run_project_analysis(scenario.project, scenario.pool, config=FAST)
    assert result.impact.supported_fraction < 0.2
    assert result.risk.score > 50


# ---- refusals ---------------------------------------------------------------

def test_a_project_with_no_forest_baseline_is_refused():
    """The artefact that made two real footprints unanalysable must fail loudly.

    A zero denominator yields 0.0% observed loss, which reads as a perfectly
    protected forest - the most flattering possible direction for a broken
    number to point.
    """
    scenario = build_scenario(seed=7)
    broken = dataclasses.replace(
        scenario.project,
        footprint=dataclasses.replace(scenario.project.footprint, forest_baseline_km2=0.0),
    )
    with pytest.raises(ProjectDataError, match="forest baseline"):
        run_project_analysis(broken, scenario.pool, config=FAST)


def test_an_empty_pool_is_refused_rather_than_answered():
    from app.models.forest_cell import UnitPool
    from app.services.candidate_filter import InsufficientCandidatesError

    scenario = build_scenario(seed=7)
    tiny = UnitPool(units=scenario.pool.units[:3], provenance=scenario.pool.provenance)
    with pytest.raises(InsufficientCandidatesError):
        run_project_analysis(scenario.project, tiny, config=FAST)


# ---- backtesting -------------------------------------------------------------

def test_backtest_series_uses_progressively_more_evidence():
    scenario = build_scenario(seed=7)
    rows = run_backtest_series(
        scenario.project, scenario.pool, cutoff_years=[2014, 2016, 2018, 2020], config=FAST
    )
    assert [r["cutoff_year"] for r in rows] == [2014, 2016, 2018, 2020]
    observed = [r["years_observed"] for r in rows if "error" not in r]
    assert observed == sorted(observed)
    assert all("error" not in r for r in rows)


def test_backtest_result_does_not_depend_on_later_data():
    """An analysis as of 2016 must not change when 2017-2020 are observed.

    The product claim - "this is what our system would have said at the time" -
    is only true if this holds.
    """
    scenario = build_scenario(seed=7)
    early = run_project_analysis(
        scenario.project, scenario.pool, config=FAST, cutoff_year=2016, include_bootstrap=False
    )
    truncated = dataclasses.replace(
        scenario.project,
        footprint=dataclasses.replace(
            scenario.project.footprint,
            cleared_km2_by_year={
                y: v
                for y, v in scenario.project.footprint.cleared_km2_by_year.items()
                if y <= 2016
            },
        ),
    )
    from app.models.forest_cell import UnitPool

    pool = UnitPool(
        units=tuple(
            dataclasses.replace(
                u,
                cleared_km2_by_year={
                    y: v for y, v in u.cleared_km2_by_year.items() if y <= 2016
                },
            )
            for u in scenario.pool.units
        ),
        provenance=scenario.pool.provenance,
    )
    late = run_project_analysis(truncated, pool, config=FAST, include_bootstrap=False)
    assert early.counterfactual.loss == pytest.approx(late.counterfactual.loss, abs=1e-12)


# ---- the response contract ---------------------------------------------------

def test_api_dict_is_json_serialisable_and_carries_its_caveats():
    import json

    scenario = build_scenario(seed=7)
    result = run_project_analysis(scenario.project, scenario.pool, config=FAST)
    payload = result.as_api_dict()

    encoded = json.dumps(payload)
    assert len(encoded) > 1000

    assert payload["provenance"]["is_finding"] is False
    assert "SYNTHETIC" in payload["provenance"]["caveat"]
    assert payload["independent_analysis"]["counterfactual_ci"]["lower"] is not None
    assert payload["synthetic_control"]["weights_locked_before_observation"] is True
    assert payload["risk"]["caveat"]
    assert payload["observed"]["caveat"]


def test_controls_carry_coordinates_similarity_and_weight():
    """What the map needs, and what makes a match explainable."""
    scenario = build_scenario(seed=7)
    result = run_project_analysis(scenario.project, scenario.pool, config=FAST)
    controls = result.contributing_controls()
    assert controls
    weighted = [c for c in controls if c["synthetic_weight"] > 0]
    assert weighted
    # Weights are rounded to five decimals for transport, so the sum is exact
    # only to about that precision across a few dozen controls.
    assert sum(c["synthetic_weight"] for c in controls) == pytest.approx(1.0, abs=1e-3)
    first = weighted[0]
    for key in ("id", "lat", "lng", "similarity", "synthetic_weight", "feature_differences"):
        assert key in first
    assert first["feature_differences"]


def test_timeseries_covers_every_observed_year():
    scenario = build_scenario(seed=7)
    result = run_project_analysis(scenario.project, scenario.pool, config=FAST)
    years = [row["year"] for row in result.timeline]
    assert years == list(result.timing.effective_post.years)
    assert result.timeline[-1]["claimed_loss"] == pytest.approx(
        scenario.project.claim.baseline_loss, abs=1e-9
    )
