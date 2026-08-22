"""Stages 7 and 8: standardise the covariates, then find the land that looks
most like the project before it started.

Matching here is a shortlisting step, not the estimator. Its job is to hand the
synthetic-control optimiser a few hundred plausible parcels instead of the whole
region, for two reasons. A convex programme over thousands of candidates will
happily find a combination that traces the project's pre-treatment path using
land that has nothing in common with it - fitting the curve while missing the
place. And a reader needs to be able to see *why* a control was chosen, which
means the shortlist has to be interpretable on its own terms.

Every distance is computed on standardised, weighted covariates measured strictly
before the project began. The per-feature differences are kept alongside each
match so the interface can show the reasoning rather than a bare score.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence

import numpy as np

from ..config import MatchingConfig
from ..models.forest_cell import ForestUnit
from ..models.project import CarbonProject
from ..utils.geo import haversine_km
from ..utils.normalization import (
    FeatureScaler,
    similarity_from_distance,
    weight_vector,
    weighted_distance,
)
from ..utils.temporal import TreatmentTiming
from . import feature_engineering as fe


@dataclass(frozen=True)
class FeatureDifference:
    """One covariate's contribution to a match, in both raw and standard units."""

    name: str
    label: str
    project_value: float | None
    control_value: float | None
    standardized_difference: float | None
    weight: float
    similarity: float

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "project_value": self.project_value,
            "control_value": self.control_value,
            "standardized_difference": (
                None
                if self.standardized_difference is None
                else round(self.standardized_difference, 4)
            ),
            "weight": self.weight,
            "similarity": round(self.similarity, 4),
        }


@dataclass(frozen=True)
class ControlMatch:
    """A candidate control and the case for it."""

    unit: ForestUnit
    distance: float
    similarity: float
    features_used: int
    feature_differences: tuple[FeatureDifference, ...]
    distance_km: float

    @property
    def unit_id(self) -> str:
        return self.unit.unit_id

    def as_dict(self) -> dict:
        return {
            "id": self.unit.unit_id,
            "label": self.unit.label,
            "lat": round(self.unit.latitude, 5),
            "lng": round(self.unit.longitude, 5),
            "distance": round(self.distance, 4),
            "similarity": round(self.similarity, 4),
            "features_used": self.features_used,
            "km_from_project": round(self.distance_km, 1),
            "feature_similarity": {
                d.name: round(d.similarity, 4) for d in self.feature_differences
            },
            "feature_differences": [d.as_dict() for d in self.feature_differences],
        }


@dataclass(frozen=True)
class MatchingResult:
    matches: tuple[ControlMatch, ...]
    scaler: FeatureScaler
    features_used: tuple[str, ...]
    project_features: Mapping[str, float | None]
    considered: int
    rejected_on_distance: int
    caliper: float = float("inf")
    caliper_relaxed: bool = False
    caliper_note: str = ""

    def units(self) -> tuple[ForestUnit, ...]:
        return tuple(m.unit for m in self.matches)

    @property
    def worst_distance(self) -> float:
        return self.matches[-1].distance if self.matches else float("nan")

    def summary(self) -> dict:
        return {
            "considered": self.considered,
            "matched": len(self.matches),
            "rejected_on_distance": self.rejected_on_distance,
            "caliper": self.caliper,
            "caliper_relaxed": self.caliper_relaxed,
            "caliper_note": self.caliper_note,
            "worst_matched_distance": (
                None if not self.matches else round(self.worst_distance, 4)
            ),
        }

    def __len__(self) -> int:
        return len(self.matches)


def standardize_features(
    rows: Sequence[Mapping[str, float | None]], features: Sequence[str]
) -> FeatureScaler:
    """Fit the scaler on the candidate pool.

    Fitted on controls only, not on controls-plus-project. With hundreds of units
    the numerical difference is negligible, but it means the yardstick the
    project is measured against does not shift when the project is added to it.
    """
    return FeatureScaler.fit(rows, features)


def match_controls(
    project: CarbonProject,
    candidates: Sequence[ForestUnit],
    timing: TreatmentTiming,
    config: MatchingConfig,
) -> MatchingResult:
    """Rank candidates by weighted, standardised covariate distance.

    The distance is a diagonal Mahalanobis: each covariate divided by its pooled
    standard deviation, multiplied by its configured weight, then combined and
    normalised by the total weight actually used. Normalising by weight rather
    than by count keeps a unit measured on nine covariates comparable with one
    measured on twelve, instead of rewarding the one with less data for having
    fewer chances to differ.

    Nearest-neighbour rather than propensity-score matching, deliberately. A
    propensity score collapses every covariate into one number, and two parcels
    with the same score can differ in opposite directions on everything that made
    it. Here the individual differences survive into the output, so a reader can
    see that a control matched on clearing history but sits 300 m higher, and
    decide for themselves whether that matters.
    """
    features = tuple(config.features)
    control_rows = fe.covariate_table(candidates, timing, features)
    scaler = standardize_features(control_rows, features)

    # Covariates absent from most of the pool cannot discriminate between units,
    # and including them mostly adds noise from the handful that do have them.
    usable = tuple(f for f in scaler.available_features(min_coverage=0.5))
    if not usable:
        raise ValueError(
            "no covariate is measured on enough of the candidate pool to match on. "
            "The data source is not supplying usable features."
        )

    project_row = fe.extract_project_features(project, timing, features)
    weights = weight_vector(features, config.weights)
    p_vals, p_mask = scaler.transform_row(project_row)
    usable_mask = np.array([f in usable for f in features], dtype=bool)
    p_mask = p_mask & usable_mask

    scored: list[ControlMatch] = []
    for unit, row in zip(candidates, control_rows):
        c_vals, c_mask = scaler.transform_row(row)
        c_mask = c_mask & usable_mask
        distance = weighted_distance(p_vals, p_mask, c_vals, c_mask, weights)
        if not np.isfinite(distance):
            continue
        both = p_mask & c_mask
        diffs = tuple(
            FeatureDifference(
                name=name,
                label=(spec.label if (spec := fe.registry().get(name)) else name),
                project_value=project_row.get(name),
                control_value=row.get(name),
                standardized_difference=float(p_vals[i] - c_vals[i]),
                weight=float(weights[i]),
                # Per-covariate similarity on the same exp(-d/2) scale as the
                # overall score, so "0.91 on road access" means the same thing
                # as "0.91 overall" rather than being a differently shaped number
                # that happens to share a range.
                similarity=similarity_from_distance(abs(float(p_vals[i] - c_vals[i]))),
            )
            for i, name in enumerate(features)
            if both[i]
        )
        scored.append(
            ControlMatch(
                unit=unit,
                distance=distance,
                similarity=similarity_from_distance(distance),
                features_used=int(both.sum()),
                feature_differences=diffs,
                distance_km=haversine_km(project.centroid, unit.centroid),
            )
        )

    scored.sort(key=lambda m: m.distance)

    # Apply the caliper, then rescue it if it bound too hard. A project unlike
    # anything in the pool is a real finding about how identifiable its
    # counterfactual is, and it should surface as low confidence on a stated
    # estimate rather than as an exception with no estimate at all - the second
    # is not more cautious, it just hides the judgement.
    within = [m for m in scored if m.distance <= config.max_distance]
    relaxed = False
    note = ""
    if len(within) < config.min_matches and len(scored) >= 2:
        relaxed = True
        within = scored[: config.min_matches]
        note = (
            f"Only {sum(1 for m in scored if m.distance <= config.max_distance)} of "
            f"{len(scored)} candidates fell inside the caliper of "
            f"{config.max_distance:.2f}. The {len(within)} nearest were taken instead, "
            f"out to a distance of {within[-1].distance:.2f}. This project is unlike "
            f"the available land and its counterfactual is correspondingly less well "
            f"identified."
        )

    rejected = len(scored) - len(within)
    return MatchingResult(
        matches=tuple(within[: config.n_neighbours]),
        scaler=scaler,
        features_used=usable,
        project_features=project_row,
        considered=len(candidates),
        rejected_on_distance=rejected,
        caliper=config.max_distance,
        caliper_relaxed=relaxed,
        caliper_note=note,
    )


def covariate_balance(
    project_features: Mapping[str, float | None],
    before: Sequence[Mapping[str, float | None]],
    after: Sequence[Mapping[str, float | None]],
    features: Sequence[str],
) -> list[dict]:
    """Standardised mean differences before and after matching.

    The standard diagnostic for whether matching achieved anything. Each figure
    is the gap between the project and the mean control, in pooled standard
    deviations. The matching literature treats |SMD| under 0.1 as good balance
    and under 0.25 as tolerable.

    Reported for the full pool and the matched set side by side, because the
    interesting number is the improvement. Matching that leaves balance unchanged
    has selected controls that were no better than picking at random, and the
    result should be read accordingly.
    """
    out: list[dict] = []
    for name in features:
        target = project_features.get(name)
        raw = np.array(
            [r[name] for r in before if r.get(name) is not None], dtype=float
        )
        matched = np.array(
            [r[name] for r in after if r.get(name) is not None], dtype=float
        )
        if target is None or raw.size == 0:
            continue
        pooled_sd = float(raw.std()) or 1.0
        spec = fe.registry().get(name)
        smd_before = (target - float(raw.mean())) / pooled_sd
        smd_after = (
            (target - float(matched.mean())) / pooled_sd if matched.size else float("nan")
        )
        out.append(
            {
                "feature": name,
                "label": spec.label if spec else name,
                "project_value": target,
                "pool_mean": float(raw.mean()),
                "matched_mean": float(matched.mean()) if matched.size else None,
                "smd_before": round(smd_before, 4),
                "smd_after": None if np.isnan(smd_after) else round(smd_after, 4),
                "improved": bool(abs(smd_after) < abs(smd_before)) if matched.size else None,
                "balanced": bool(abs(smd_after) < 0.25) if matched.size else None,
            }
        )
    return out
