"""The convex programme: constraints, locking, and whether it recovers a truth.

The most important test here is `test_recovers_a_known_convex_combination`. The
fixture builds a treated unit that is, by construction, an exact mixture of three
controls. A correct optimiser handed that pool must find a combination that
reproduces it. If it cannot solve a problem whose answer was planted, nothing it
says about a real project is worth reading.
"""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from app.config import DEFAULT_CONFIG, SyntheticControlConfig
from app.services import feature_engineering as fe
from app.services.control_matching import match_controls
from app.services.synthetic_control import (
    SyntheticControlError,
    apply_locked_weights,
    build_synthetic_control,
    synthetic_series,
)
from app.utils.normalization import FeatureScaler
from app.utils.temporal import TemporalLeakError, TreatmentTiming, Window
from tests.fixtures.synthetic_forest import build_scenario

CONFIG = SyntheticControlConfig()


def _setup(seed: int = 7, unit_ids: tuple[str, ...] | None = None):
    """Build the inputs the optimiser takes, from the synthetic scenario."""
    scenario = build_scenario(seed=seed)
    timing = TreatmentTiming(
        start_year=scenario.start_year,
        pre_period=Window(scenario.start_year - 8, scenario.start_year - 1),
        post_period=Window(scenario.start_year, scenario.last_year),
    )
    features = tuple(DEFAULT_CONFIG.matching.features)
    units = {
        u.unit_id: u
        for u in scenario.pool.units
        if unit_ids is None or u.unit_id in unit_ids
    }
    control_features = {
        uid: fe.extract_cell_features(u, timing, features) for uid, u in units.items()
    }
    scaler = FeatureScaler.fit(list(control_features.values()), features)
    project_pre = fe.extract_pre_trajectory(scenario.project.footprint, timing)
    control_pres = {uid: fe.extract_pre_trajectory(u, timing) for uid, u in units.items()}
    project_features = fe.extract_project_features(scenario.project, timing, features)
    return scenario, timing, units, control_pres, control_features, project_pre, project_features, scaler


def _fit(*args, config: SyntheticControlConfig = CONFIG):
    (_, _, _, control_pres, control_features, project_pre, project_features, scaler) = args
    return build_synthetic_control(
        project_pre=project_pre,
        control_pres=control_pres,
        project_features=project_features,
        control_features=control_features,
        scaler=scaler,
        feature_weights=DEFAULT_CONFIG.matching.weights,
        config=config,
    )


# ---- the constraints that make the estimate defensible --------------------

def test_weights_are_non_negative_and_sum_to_one():
    """The two constraints that keep the counterfactual inside observed reality.

    Negative weights would let the model build a counterfactual by subtracting
    one parcel from another, producing forest cover no real land exhibited.
    Weights summing to one keep the synthetic control inside the convex hull of
    the donors, so it can never claim a rate of deforestation that nothing
    actually did.
    """
    fit = _fit(*_setup())
    assert (fit.weights >= 0).all()
    assert fit.weights.sum() == pytest.approx(1.0, abs=1e-8)


def test_synthetic_control_cannot_exceed_the_donor_range():
    """A direct consequence of convexity, worth asserting rather than assuming."""
    setup = _setup()
    scenario, timing, units, control_pres, *_ = setup
    fit = _fit(*setup)
    window = Window(timing.start_year, timing.post_period.end)
    series = synthetic_series(fit, units, window, anchor_year=window.start)

    from app.services.forest_service import remaining_fraction_series

    donor_series = [
        remaining_fraction_series(units[cid], window, anchor_year=window.start)
        for cid, w in fit.contributing
    ]
    for year in window.years:
        lo = min(d[year] for d in donor_series)
        hi = max(d[year] for d in donor_series)
        assert lo - 1e-9 <= series[year] <= hi + 1e-9


def test_recovers_a_known_convex_combination():
    """The planted-answer test.

    The treated unit is built as an exact mixture of S003, S017 and S041. Given
    only those three as donors, the optimiser must reproduce its pre-treatment
    path almost perfectly and put its weight on them.
    """
    setup = _setup(unit_ids=("S003", "S017", "S041"))
    scenario = setup[0]
    fit = _fit(*setup)

    assert fit.pre_rmse < 0.002, (
        f"a perfect fit exists by construction but the optimiser found one with "
        f"RMSE {fit.pre_rmse:.5f}"
    )
    assert set(fit.control_ids) == set(scenario.donor_ids)
    assert fit.weights.sum() == pytest.approx(1.0, abs=1e-8)


def test_fit_beats_an_equal_weighted_average():
    """The reason for optimising at all.

    If a plain mean of the matched controls reproduced the project's history as
    well as the fitted combination, the convex programme would be ceremony.
    """
    setup = _setup()
    fit = _fit(*setup)
    _, _, _, control_pres, *_ = setup
    project_pre = setup[5]

    matrix = np.column_stack([np.array(control_pres[cid].vector()) for cid in fit.control_ids])
    equal = matrix @ (np.ones(len(fit.control_ids)) / len(fit.control_ids))
    target = np.array(project_pre.vector())

    from app.utils.stats import rmse

    assert fit.pre_rmse < rmse(target, equal)


# ---- locking ---------------------------------------------------------------

def test_weights_are_immutable_once_fitted():
    """The lock is structural, not a convention.

    A caller holding the fit cannot edit the weights in place, so no code path
    downstream of the optimiser can adjust them in the light of what it sees in
    the post-treatment years.
    """
    fit = _fit(*_setup())
    with pytest.raises(ValueError):
        fit.weights[0] = 0.5
    with pytest.raises(dataclasses.FrozenInstanceError):
        fit.pre_rmse = 0.0


def test_applying_weights_uses_only_the_fitted_donors():
    setup = _setup()
    _, timing, units, *_ = setup
    fit = _fit(*setup)
    window = Window(timing.start_year, timing.post_period.end)
    values = apply_locked_weights(fit, units, window, anchor_year=window.start)
    assert len(values) == window.length
    assert values[0] == pytest.approx(1.0, abs=1e-9)


def test_applying_weights_fails_loudly_on_a_missing_donor():
    setup = _setup()
    _, timing, units, *_ = setup
    fit = _fit(*setup)
    incomplete = {k: v for k, v in units.items() if k != fit.control_ids[0]}
    with pytest.raises(ValueError, match="units missing"):
        apply_locked_weights(
            fit, incomplete, Window(timing.start_year, timing.post_period.end), timing.start_year
        )


# ---- refusals --------------------------------------------------------------

def test_mismatched_pre_windows_are_rejected():
    """Fitting across windows of different lengths would compare years only one
    side lived through, which is a leak in disguise."""
    setup = _setup()
    scenario, timing, units, control_pres, control_features, project_pre, project_features, scaler = setup

    shorter = TreatmentTiming(
        start_year=timing.start_year,
        pre_period=Window(timing.start_year - 5, timing.start_year - 1),
        post_period=timing.post_period,
    )
    bad_id = next(iter(control_pres))
    control_pres = dict(control_pres)
    control_pres[bad_id] = fe.extract_pre_trajectory(units[bad_id], shorter)

    with pytest.raises(TemporalLeakError, match="differs from the project"):
        build_synthetic_control(
            project_pre=project_pre,
            control_pres=control_pres,
            project_features=project_features,
            control_features=control_features,
            scaler=scaler,
            feature_weights=DEFAULT_CONFIG.matching.weights,
            config=CONFIG,
        )


def test_a_single_donor_is_refused():
    setup = _setup(unit_ids=("S003",))
    with pytest.raises(SyntheticControlError, match="at least two donors"):
        _fit(*setup)


# ---- diagnostics -----------------------------------------------------------

def test_effective_control_count_sees_through_a_dominant_weight():
    """Four donors where one carries 97% is one donor wearing a disguise."""
    from app.utils.stats import effective_count

    assert effective_count(np.array([0.25, 0.25, 0.25, 0.25])) == pytest.approx(4.0)
    assert effective_count(np.array([0.97, 0.01, 0.01, 0.01])) < 1.1


def test_dust_weights_are_zeroed_not_reported():
    """Otherwise the control list reads as "built from 200 parcels" when six did
    the work."""
    fit = _fit(*_setup())
    tiny = [w for w in fit.weights if 0 < w < CONFIG.weight_floor]
    assert not tiny
    assert len(fit.contributing) == int((fit.weights > 0).sum())


def test_covariate_lambda_trades_covariate_balance_for_trajectory_fit():
    """The covariate term must actually do something, or it is decoration.

    What it does is pull weight toward donors that resemble the project on its
    static characteristics, at some cost to the trajectory fit. So the assertion
    is on covariate distance, which is the quantity the term controls.

    The trajectory side is only checked to a loose tolerance, and that looseness
    is the point rather than a concession. With around 50 donors and 9
    pre-treatment observations the trajectory objective is badly
    underdetermined: many quite different weightings reproduce the pre-period to
    within 1e-4, so which one the solver returns is arbitrary at that scale.
    That degeneracy is the central limitation of synthetic control on short
    pre-periods - it is why `test_pipeline` measures the estimator's accuracy
    against a known truth rather than trusting a good pre-treatment fit to imply
    one, and why the covariate term is switched on by default.
    """
    setup = _setup()
    pure = _fit(*setup, config=dataclasses.replace(CONFIG, covariate_lambda=0.0))
    weighted = _fit(*setup, config=dataclasses.replace(CONFIG, covariate_lambda=5.0))

    assert pure.weights.tolist() != pytest.approx(weighted.weights.tolist(), abs=1e-6)
    assert weighted.covariate_distance < pure.covariate_distance
    assert pure.pre_rmse <= weighted.pre_rmse + 1e-3


def test_the_trajectory_objective_is_underdetermined_on_a_short_pre_period():
    """Documents the degeneracy above as a measured fact rather than a caveat.

    Two runs that differ only in a term unrelated to the trajectory both fit the
    pre-period to well under a tenth of a percentage point, while placing their
    weight on materially different parcels. A near-perfect pre-treatment fit is
    therefore weak evidence that the right donors were found, which is exactly
    why `model_quality` reports effective control count and weight concentration
    alongside RMSE instead of leading with fit alone.
    """
    setup = _setup()
    a = _fit(*setup, config=dataclasses.replace(CONFIG, covariate_lambda=0.0))
    b = _fit(*setup, config=dataclasses.replace(CONFIG, covariate_lambda=5.0))

    assert a.pre_rmse < 1e-3 and b.pre_rmse < 1e-3
    overlap = float(np.minimum(a.weights, b.weights).sum())
    assert overlap < 0.95, (
        "the two weightings agree almost exactly, so this fixture no longer "
        "demonstrates the degeneracy it is documenting"
    )
