"""Standardisation, distance, filtering and balance.

The failure this suite is mostly guarding against is silent: matching that
appears to work, returns plausible controls, and has quietly let one covariate
with big numbers decide everything, or has imputed a missing value into a
similarity the data never supported.
"""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from app.config import DEFAULT_CONFIG, MatchingConfig
from app.models.forest_cell import UnitPool
from app.services import candidate_filter as cf
from app.services import feature_engineering as fe
from app.services.control_matching import covariate_balance, match_controls
from app.services.trajectory import calculate_trajectory_similarity, filter_by_trajectory
from app.utils.geo import bbox_separation_km, haversine_km
from app.utils.normalization import FeatureScaler, weight_vector, weighted_distance
from app.utils.temporal import PreTreatmentView, TreatmentTiming, Window
from tests.fixtures.synthetic_forest import build_scenario


def _timing(start=2011, pre=8, last=2020, cutoff=None):
    return TreatmentTiming(
        start_year=start,
        pre_period=Window(start - pre, start - 1),
        post_period=Window(start, last),
        cutoff_year=cutoff,
    )


# ---- standardisation --------------------------------------------------------

def test_units_are_put_on_a_common_scale():
    """Elevation in metres must not outvote a fraction just for being bigger."""
    rows = [
        {"elevation": 100.0, "forest_cover": 0.90},
        {"elevation": 900.0, "forest_cover": 0.50},
        {"elevation": 500.0, "forest_cover": 0.70},
    ]
    scaler = FeatureScaler.fit(rows, ["elevation", "forest_cover"])
    values, _ = scaler.transform(rows)
    assert values[:, 0].std() == pytest.approx(values[:, 1].std(), abs=1e-9)


def test_a_constant_covariate_contributes_nothing():
    """Zero variance means zero information; it must not divide by ~0."""
    rows = [{"elevation": 500.0} for _ in range(5)]
    scaler = FeatureScaler.fit(rows, ["elevation"])
    values, mask = scaler.transform(rows)
    assert np.all(values == 0.0)
    assert mask.all()


def test_missing_values_are_skipped_not_imputed():
    """An unmeasured slope is not a flat slope.

    Imputing the pool mean would manufacture similarity the data cannot support,
    and it would do so invisibly - the match would score well for a covariate
    nobody measured.
    """
    rows = [{"slope": 5.0}, {"slope": 15.0}, {"slope": None}]
    scaler = FeatureScaler.fit(rows, ["slope"])
    _, mask = scaler.transform_row(rows[2])
    assert not mask[0]

    weights = weight_vector(["slope"], {"slope": 1.0})
    a_vals, a_mask = scaler.transform_row(rows[0])
    c_vals, c_mask = scaler.transform_row(rows[2])
    assert weighted_distance(a_vals, a_mask, c_vals, c_mask, weights) == float("inf")


def test_distance_is_comparable_across_units_with_different_coverage():
    """Normalising by summed weight, not count, so a unit measured on fewer
    covariates is not rewarded for having fewer chances to differ."""
    features = ["a", "b"]
    rows = [{"a": 0.0, "b": 0.0}, {"a": 1.0, "b": 1.0}, {"a": 2.0, "b": 2.0}]
    scaler = FeatureScaler.fit(rows, features)
    weights = weight_vector(features, {"a": 1.0, "b": 1.0})

    target, t_mask = scaler.transform_row({"a": 0.0, "b": 0.0})
    both, b_mask = scaler.transform_row({"a": 1.0, "b": 1.0})
    one, o_mask = scaler.transform_row({"a": 1.0, "b": None})

    assert weighted_distance(target, t_mask, both, b_mask, weights) == pytest.approx(
        weighted_distance(target, t_mask, one, o_mask, weights)
    )


def test_feature_weights_shift_which_control_is_closest():
    """The weights must actually steer matching, or they are documentation."""
    features = ["historical_loss_rate", "elevation"]
    rows = [
        {"historical_loss_rate": 0.0, "elevation": 0.0},
        {"historical_loss_rate": 1.0, "elevation": 0.0},
        {"historical_loss_rate": 0.0, "elevation": 1.0},
    ]
    scaler = FeatureScaler.fit(rows, features)
    target, t_mask = scaler.transform_row(rows[0])
    a_vals, a_mask = scaler.transform_row(rows[1])
    b_vals, b_mask = scaler.transform_row(rows[2])

    history_heavy = weight_vector(features, {"historical_loss_rate": 4.0, "elevation": 1.0})
    assert weighted_distance(target, t_mask, a_vals, a_mask, history_heavy) > weighted_distance(
        target, t_mask, b_vals, b_mask, history_heavy
    )
    elevation_heavy = weight_vector(features, {"historical_loss_rate": 1.0, "elevation": 4.0})
    assert weighted_distance(target, t_mask, a_vals, a_mask, elevation_heavy) < weighted_distance(
        target, t_mask, b_vals, b_mask, elevation_heavy
    )


# ---- eligibility ------------------------------------------------------------

def test_protected_land_is_excluded():
    """Protected land shows what happens under protection, not without it."""
    scenario = build_scenario(seed=7)
    protected = UnitPool(
        units=tuple(
            dataclasses.replace(u, protected_fraction=0.9) if i % 2 == 0 else u
            for i, u in enumerate(scenario.pool.units)
        ),
        provenance=scenario.pool.provenance,
    )
    pool = cf.build_candidate_pool(scenario.project, protected, _timing(), MatchingConfig())
    assert all(u.protected_fraction <= 0.25 for u in pool.units)
    assert pool.reasons().get("protected", 0) > 0


def test_other_carbon_projects_are_excluded():
    scenario = build_scenario(seed=7)
    tagged = UnitPool(
        units=(dataclasses.replace(scenario.pool.units[0], is_carbon_project=True),)
        + scenario.pool.units[1:],
        provenance=scenario.pool.provenance,
    )
    pool = cf.build_candidate_pool(scenario.project, tagged, _timing(), MatchingConfig())
    assert scenario.pool.units[0].unit_id not in {u.unit_id for u in pool.units}
    assert pool.reasons().get("other_carbon_project") == 1


def test_units_inside_the_leakage_buffer_are_excluded():
    """Clearing displaced by a project lands nearby and would inflate the
    counterfactual in the project's favour."""
    scenario = build_scenario(seed=7)
    config = MatchingConfig(exclusion_buffer_km=500.0)
    pool = cf.build_candidate_pool(scenario.project, scenario.pool, _timing(), config)
    for unit in pool.units:
        assert (
            bbox_separation_km(
                scenario.project.footprint.bbox,
                scenario.project.centroid,
                unit.bbox,
                unit.centroid,
            )
            >= 500.0
        )


def test_leakage_buffer_measures_clear_space_not_centroid_distance():
    """Two adjacent 1-degree parcels have centroids 110 km apart and no land
    between them. A centroid buffer would accept the parcel most likely to
    absorb displaced clearing."""
    a_box, a_centre = (-60.0, -10.0, -59.0, -9.0), (-59.5, -9.5)
    b_box, b_centre = (-59.0, -10.0, -58.0, -9.0), (-58.5, -9.5)
    assert haversine_km(a_centre, b_centre) > 100
    assert bbox_separation_km(a_box, a_centre, b_box, b_centre) == 0.0


def test_units_with_gaps_in_their_history_are_excluded():
    """A missing year is unknown, not calm forest."""
    scenario = build_scenario(seed=7)
    gappy = UnitPool(
        units=(
            dataclasses.replace(
                scenario.pool.units[0],
                cleared_km2_by_year={
                    y: v
                    for y, v in scenario.pool.units[0].cleared_km2_by_year.items()
                    if y != 2007
                },
            ),
        )
        + scenario.pool.units[1:],
        provenance=scenario.pool.provenance,
    )
    pool = cf.build_candidate_pool(scenario.project, gappy, _timing(), MatchingConfig())
    assert pool.reasons().get("incomplete_pre_history") == 1


def test_every_exclusion_is_recorded_with_a_reason():
    """The share of the pool discarded is a confidence signal, not bookkeeping."""
    scenario = build_scenario(seed=7)
    pool = cf.build_candidate_pool(
        scenario.project, scenario.pool, _timing(), MatchingConfig(exclusion_buffer_km=300)
    )
    summary = pool.summary()
    assert summary["considered"] == len(scenario.pool)
    assert summary["eligible"] + summary["rejected"] == summary["considered"]
    assert all(e.reason for e in pool.exclusions)


# ---- shortlisting -----------------------------------------------------------

def test_matches_are_ranked_by_distance():
    scenario = build_scenario(seed=7)
    timing = _timing()
    candidates = cf.build_candidate_pool(scenario.project, scenario.pool, timing, MatchingConfig())
    result = match_controls(scenario.project, candidates.units, timing, MatchingConfig())
    distances = [m.distance for m in result.matches]
    assert distances == sorted(distances)


def test_a_binding_caliper_is_relaxed_and_reported():
    """A project unlike anything available should produce a labelled weak answer
    rather than no answer - the second is not more cautious, it just moves the
    judgement somewhere nobody can see it."""
    scenario = build_scenario(seed=7)
    timing = _timing()
    candidates = cf.build_candidate_pool(scenario.project, scenario.pool, timing, MatchingConfig())
    strict = MatchingConfig(max_distance=1e-6, min_matches=12)
    result = match_controls(scenario.project, candidates.units, timing, strict)
    assert result.caliper_relaxed is True
    assert len(result.matches) == 12
    assert "caliper" in result.caliper_note


def test_each_match_explains_itself():
    """The interface has to be able to say why a control was chosen."""
    scenario = build_scenario(seed=7)
    timing = _timing()
    candidates = cf.build_candidate_pool(scenario.project, scenario.pool, timing, MatchingConfig())
    result = match_controls(scenario.project, candidates.units, timing, MatchingConfig())
    row = result.matches[0].as_dict()
    assert 0.0 <= row["similarity"] <= 1.0
    assert row["feature_differences"]
    for diff in row["feature_differences"]:
        assert diff["project_value"] is not None
        assert diff["weight"] > 0


def test_matching_improves_covariate_balance():
    """Matching that leaves balance unchanged has selected controls no better
    than random, and the result should be read that way."""
    scenario = build_scenario(seed=7)
    timing = _timing()
    features = tuple(DEFAULT_CONFIG.matching.features)
    candidates = cf.build_candidate_pool(scenario.project, scenario.pool, timing, MatchingConfig())
    result = match_controls(scenario.project, candidates.units, timing, MatchingConfig())

    balance = covariate_balance(
        project_features=result.project_features,
        before=fe.covariate_table(candidates.units, timing, features),
        after=[fe.extract_cell_features(m.unit, timing, features) for m in result.matches],
        features=result.features_used,
    )
    assert balance
    improved = [b for b in balance if b["improved"]]
    assert len(improved) >= len(balance) / 2


# ---- trajectory filtering ---------------------------------------------------

def _view(values, start=2003):
    window = Window(start, start + len(values) - 1)
    return PreTreatmentView({start + i: v for i, v in enumerate(values)}, window, "t")


def test_a_flat_control_is_rejected_on_trajectory():
    """The most dangerous control: one that never loses anything drags the
    counterfactual toward zero and flatters every project.

    The worked example from the brief - a project falling to 96.9% over six
    years, against a control that stays at 100% throughout. Note that its RMSE is
    0.019, *below* the absolute 0.02 ceiling: a fixed threshold cannot catch this
    case, because a flat line can only ever be about as far from the project as
    the project moved. It is caught by the relative rule and by the variation
    rule, and the rejection reason has to say so.
    """
    project = _view([1.0, 0.994, 0.988, 0.981, 0.976, 0.969])
    flat = _view([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])
    score = calculate_trajectory_similarity(project, flat, "FLAT", DEFAULT_CONFIG.trajectory)
    assert score.passed is False
    assert score.rmse < DEFAULT_CONFIG.trajectory.max_rmse
    assert "barely moved" in score.reason


def test_a_parallel_control_is_accepted():
    project = _view([1.0, 0.994, 0.988, 0.981, 0.976, 0.969])
    good = _view([1.0, 0.995, 0.989, 0.983, 0.977, 0.971])
    score = calculate_trajectory_similarity(project, good, "GOOD", DEFAULT_CONFIG.trajectory)
    assert score.passed is True
    assert score.correlation > 0.99


def test_trajectory_filter_relaxes_rather_than_returning_nothing():
    project = _view([1.0, 0.9, 0.8, 0.7, 0.6, 0.5])
    controls = {f"C{i}": _view([1.0, 1.0, 1.0, 1.0, 1.0, 1.0 - i * 0.001]) for i in range(20)}
    result = filter_by_trajectory(project, controls, DEFAULT_CONFIG.trajectory)
    assert result.relaxed is True
    assert len(result.kept) == DEFAULT_CONFIG.trajectory.min_controls_retained
    assert "below the floor" in result.note
