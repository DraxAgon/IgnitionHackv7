"""Stage 16: the analysis reporting on its own reliability.

A counterfactual estimator that cannot say when it is guessing is worse than no
estimator, because it launders a guess into a number that looks like a
measurement. Everything here exists to let a reader discount the headline result
without having to re-derive it.

The metrics fall into three groups:

  Fit          Did the weighted controls actually reproduce the project's
               pre-treatment path? If not, there is no reason to believe they
               reproduce what would have happened next.
  Composition  Is the estimate spread across genuinely different parcels, or is
               it one parcel with a rounding error attached?
  Balance      Did matching improve covariate similarity over the raw pool, or
               did it just pick the first hundred?

The confidence label is a summary of these and nothing more. It never reflects
how large the discrepancy is - a strong analysis that finds a project's baseline
reasonable and a strong analysis that finds it overstated should both report high
confidence. Letting the size of the finding influence the confidence in the
finding is how a screening tool becomes a machine for confirming its own
suspicions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np

from ..models.forest_cell import ForestUnit
from ..utils.geo import haversine_km
from ..utils.stats import safe_divide
from .synthetic_control import SyntheticControlFit


@dataclass(frozen=True)
class ModelQuality:
    pre_treatment_rmse: float
    pre_treatment_mae: float
    pre_treatment_correlation: float
    pre_treatment_fit: float
    effective_controls: float
    max_single_weight: float
    contributing_controls: int
    control_match_quality: float
    mean_match_distance: float
    geographic_spread_km: float
    balance_share: float
    rejection_rate: float
    interval_width: float | None
    bootstrap_convergence: float
    confidence: str
    warnings: tuple[str, ...]

    def as_dict(self) -> dict:
        return {
            "pre_treatment_rmse": round(self.pre_treatment_rmse, 5),
            "pre_treatment_mae": round(self.pre_treatment_mae, 5),
            "pre_treatment_correlation": round(self.pre_treatment_correlation, 4),
            "pre_treatment_fit": round(self.pre_treatment_fit, 4),
            "effective_controls": round(self.effective_controls, 2),
            "max_single_weight": round(self.max_single_weight, 4),
            "contributing_controls": self.contributing_controls,
            "control_match_quality": round(self.control_match_quality, 4),
            "mean_match_distance": round(self.mean_match_distance, 4),
            "geographic_spread_km": round(self.geographic_spread_km, 1),
            "covariate_balance_share": round(self.balance_share, 4),
            "candidate_rejection_rate": round(self.rejection_rate, 4),
            "confidence_interval_width": (
                None if self.interval_width is None else round(self.interval_width, 5)
            ),
            "bootstrap_convergence": round(self.bootstrap_convergence, 4),
            "confidence": self.confidence,
            "warnings": list(self.warnings),
        }


def pre_treatment_fit_score(pre_rmse: float, project_pre: np.ndarray) -> float:
    """Turn a pre-treatment RMSE into a 0-1 fit score.

    Normalised by how much the project's own pre-treatment series actually moved.
    An RMSE of 0.004 is excellent against a project that lost 8% of its forest
    over the pre-period and unimpressive against one that lost 40%, so an
    absolute threshold would rate stable projects generously and dynamic ones
    harshly for the same quality of fit.

    The floor on the reference scale stops a project whose forest barely changed
    from producing a fit score that swings wildly on numerical noise.
    """
    reference = max(float(np.std(project_pre)), 0.01)
    return float(np.clip(1.0 - pre_rmse / reference, 0.0, 1.0))


def control_quality_score(
    mean_distance: float, effective_controls: float, max_weight: float
) -> float:
    """A 0-1 summary of whether the donor set is any good.

    Three factors, multiplied so that a failure in any one of them pulls the
    whole score down - they are not substitutes for each other:

      Closeness   exp(-mean weighted covariate distance), on the same scale as
                  the similarity scores reported per control.
      Diversity   effective control count saturating at five. Below that the
                  estimate rests on too few parcels for the weighting to have
                  done anything meaningful.
      Concentration  a penalty as the largest single weight approaches one. A
                  "synthetic control" that is 90% one parcel is a single-control
                  comparison and should not inherit the credibility of the
                  method's name.
    """
    closeness = float(np.exp(-mean_distance)) if np.isfinite(mean_distance) else 0.0
    diversity = float(np.clip(effective_controls / 5.0, 0.0, 1.0))
    concentration = float(np.clip(1.0 - max(0.0, max_weight - 0.5) / 0.5, 0.0, 1.0))
    return float(closeness * diversity * concentration) ** (1 / 3) if closeness > 0 else 0.0


def geographic_spread(
    fit: SyntheticControlFit, units: Mapping[str, ForestUnit]
) -> float:
    """Mean pairwise distance between the parcels actually carrying weight, in km.

    A guard against a specific failure: a synthetic control assembled entirely
    from one valley. Such a set can fit the pre-treatment path beautifully and
    still share a single road, a single enforcement regime and a single commodity
    market with the project, so its post-treatment behaviour is one observation
    dressed up as several.
    """
    contributing = [cid for cid, w in fit.contributing if w > 0.01]
    points = [units[cid].centroid for cid in contributing if cid in units]
    if len(points) < 2:
        return 0.0
    dists = [
        haversine_km(points[i], points[j])
        for i in range(len(points))
        for j in range(i + 1, len(points))
    ]
    return float(np.mean(dists))


def calculate_model_quality(
    fit: SyntheticControlFit,
    units: Mapping[str, ForestUnit],
    match_distances: Sequence[float],
    balance: Sequence[Mapping],
    rejection_rate: float,
    interval_width: float | None,
    bootstrap_convergence: float,
    caliper_relaxed: bool = False,
    trajectory_relaxed: bool = False,
) -> ModelQuality:
    """Assemble the quality report and decide a confidence label.

    The thresholds below are stated as explicit rules rather than folded into a
    formula, so that a reader can disagree with any one of them and see exactly
    what it changed. They are judgement calls informed by the diagnostics the
    synthetic-control literature reports, not derived constants, and they are the
    first thing that should be revisited once the placebo suite has run over
    enough locations to calibrate them empirically.
    """
    fit_score = pre_treatment_fit_score(fit.pre_rmse, fit.pre_project)
    weighted_distances = [
        d for d, cid in zip(match_distances, fit.control_ids) if fit.weight_for(cid) > 0
    ]
    mean_distance = float(np.mean(weighted_distances)) if weighted_distances else float("nan")
    quality = control_quality_score(mean_distance, fit.effective_controls, fit.max_weight)
    spread = geographic_spread(fit, units)

    assessed = [b for b in balance if b.get("smd_after") is not None]
    balance_share = safe_divide(
        sum(1 for b in assessed if abs(b["smd_after"]) < 0.25), len(assessed), default=0.0
    )

    warnings: list[str] = []
    if caliper_relaxed:
        warnings.append(
            "Too few candidates fell inside the covariate caliper, so the nearest "
            "available were used instead. The project is unlike the land it is being "
            "compared against."
        )
    if trajectory_relaxed:
        warnings.append(
            "Too few controls met the pre-treatment trajectory thresholds, so the "
            "closest by RMSE were used instead."
        )
    if fit_score < 0.6:
        warnings.append(
            f"The weighted controls reproduce the project's pre-treatment path only "
            f"loosely (RMSE {fit.pre_rmse:.4f}). The counterfactual should be read as "
            f"indicative."
        )
    if fit.effective_controls < 3:
        warnings.append(
            f"The estimate rests on an effective {fit.effective_controls:.1f} controls. "
            f"It is close to a comparison against a single parcel."
        )
    if fit.max_weight > 0.6:
        warnings.append(
            f"One control carries {fit.max_weight:.0%} of the weight, so the result "
            f"largely reflects that parcel."
        )
    if spread and spread < 100:
        warnings.append(
            f"Contributing controls average {spread:.0f} km apart and may share local "
            f"drivers with each other and with the project."
        )
    if balance_share < 0.7 and assessed:
        warnings.append(
            f"Only {balance_share:.0%} of covariates reached acceptable balance after "
            f"matching."
        )
    if rejection_rate > 0.9:
        warnings.append(
            f"{rejection_rate:.0%} of candidate units were excluded, so the donor pool "
            f"is a narrow slice of the region."
        )
    if bootstrap_convergence < 0.8:
        warnings.append(
            f"Only {bootstrap_convergence:.0%} of bootstrap refits converged; the "
            f"interval may understate uncertainty."
        )

    if fit_score >= 0.8 and quality >= 0.6 and fit.effective_controls >= 4 and not warnings:
        confidence = "HIGH"
    elif fit_score >= 0.6 and quality >= 0.4 and fit.effective_controls >= 2.5:
        confidence = "MODERATE"
    else:
        confidence = "LOW"

    return ModelQuality(
        pre_treatment_rmse=fit.pre_rmse,
        pre_treatment_mae=fit.pre_mae,
        pre_treatment_correlation=fit.pre_correlation,
        pre_treatment_fit=fit_score,
        effective_controls=fit.effective_controls,
        max_single_weight=fit.max_weight,
        contributing_controls=len(fit.contributing),
        control_match_quality=quality,
        mean_match_distance=mean_distance,
        geographic_spread_km=spread,
        balance_share=balance_share,
        rejection_rate=rejection_rate,
        interval_width=interval_width,
        bootstrap_convergence=bootstrap_convergence,
        confidence=confidence,
        warnings=tuple(warnings),
    )
