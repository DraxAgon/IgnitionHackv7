"""Stage 9: filtering controls on the shape of their history, not just their
description.

Covariate matching answers "did this parcel look like the project?". It does not
answer "was this parcel *behaving* like the project?", and the second question is
the one that matters. A parcel can match on forest cover, elevation, rainfall and
road access while having lost nothing at all for a decade - and a control that
never loses forest is the most dangerous kind, because it drags the
counterfactual toward zero and makes every project it touches look like it
avoided nothing.

The reverse error is just as real: filter on trajectory too aggressively and the
retained controls are the ones that happen to trace the project's pre-treatment
path, which is exactly what the optimiser is about to fit. Over-filtering here
pre-selects on the outcome variable's own history and produces an artificially
tight pre-treatment fit that means nothing.

So the thresholds are deliberately loose. This stage removes controls that are
clearly the wrong kind of land. Choosing among the rest is the optimiser's job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

from ..config import TrajectoryConfig
from ..models.forest_cell import ForestUnit
from ..utils.stats import correlation, mae, ols_slope, rmse
from ..utils.temporal import PreTreatmentView, TemporalLeakError


@dataclass(frozen=True)
class TrajectorySimilarity:
    """How closely one control's pre-treatment path tracks the project's."""

    unit_id: str
    rmse: float
    mae: float
    correlation: float
    slope_difference: float
    passed: bool
    reason: str = ""

    def as_dict(self) -> dict:
        return {
            "id": self.unit_id,
            "rmse": round(self.rmse, 5),
            "mae": round(self.mae, 5),
            "correlation": round(self.correlation, 4),
            "slope_difference": round(self.slope_difference, 5),
            "passed": self.passed,
            "reason": self.reason,
        }


def calculate_trajectory_similarity(
    project_pre: PreTreatmentView,
    control_pre: PreTreatmentView,
    unit_id: str,
    config: TrajectoryConfig,
) -> TrajectorySimilarity:
    """Compare two pre-treatment forest paths on four complementary measures.

    RMSE
        Average disagreement in level, in forest-fraction units, penalising
        large gaps more than small ones. The primary filter.

    MAE
        The same in absolute terms. Reported alongside RMSE because a control
        that tracks perfectly except for one bad year has a high RMSE and a low
        MAE, and that difference is worth seeing rather than smoothing away.

    Correlation
        Whether the two move together at all. A control whose forest recovers
        while the project's falls is the wrong kind of land regardless of how
        close the levels happen to be.

    Slope difference
        Whether they were clearing at the same pace. Two parcels can sit at
        similar levels throughout while one is stable and the other is losing
        forest steadily toward the same point from above.

    Both series are indexed by stock year and are anchored at 1.0 in the first
    pre-treatment year, so this compares shapes rather than sizes.
    """
    if project_pre.window != control_pre.window:
        raise TemporalLeakError(
            f"{unit_id}: trajectory windows differ ({project_pre.window} vs "
            f"{control_pre.window}). Comparing paths measured over different years "
            f"would smuggle in a period the other side never saw."
        )

    p = np.array(project_pre.vector(), dtype=float)
    c = np.array(control_pre.vector(), dtype=float)

    error = rmse(p, c)
    abs_error = mae(p, c)
    corr = correlation(p, c)
    slope_gap = abs(ols_slope(p) - ols_slope(c))

    # Scale the tolerance to how much the project's own path actually moved.
    # A fixed cutoff is meaningless here: against a project that lost 3% over its
    # pre-period, even a perfectly flat control sits only 0.03 away, so any
    # absolute threshold in that range admits the one control guaranteed to bias
    # the counterfactual downward.
    project_variation = float(np.std(p))
    relative_limit = max(config.rmse_floor, config.max_rmse_ratio * project_variation)
    control_variation = float(np.std(c))

    reasons: list[str] = []
    if error > relative_limit:
        reasons.append(
            f"path differs by {error:.4f} RMSE against a limit of {relative_limit:.4f} "
            f"(the project's own pre-treatment variation was {project_variation:.4f})"
        )
    if error > config.max_rmse:
        reasons.append(f"path differs by {error:.4f} RMSE, absolute ceiling {config.max_rmse:.3f}")
    if project_variation > config.rmse_floor and control_variation < (
        config.min_variation_ratio * project_variation
    ):
        reasons.append(
            f"barely moved ({control_variation:.4f} standard deviation) while the "
            f"project's forest was changing ({project_variation:.4f}); land that never "
            f"loses anything is not a counterfactual for land that was"
        )
    if corr < config.min_correlation:
        reasons.append(f"correlation {corr:.2f} below {config.min_correlation:.2f}")
    if slope_gap > config.max_slope_difference:
        reasons.append(
            f"clearing pace differs by {slope_gap:.4f}/yr, limit "
            f"{config.max_slope_difference:.4f}"
        )

    return TrajectorySimilarity(
        unit_id=unit_id,
        rmse=error,
        mae=abs_error,
        correlation=corr,
        slope_difference=slope_gap,
        passed=not reasons,
        reason="; ".join(reasons),
    )


@dataclass(frozen=True)
class TrajectoryFilterResult:
    kept: tuple[str, ...]
    scores: tuple[TrajectorySimilarity, ...]
    relaxed: bool
    note: str = ""

    def summary(self) -> dict:
        return {
            "evaluated": len(self.scores),
            "kept": len(self.kept),
            "rejected": len(self.scores) - len(self.kept),
            "relaxed_to_meet_minimum": self.relaxed,
            "note": self.note,
        }


def filter_by_trajectory(
    project_pre: PreTreatmentView,
    control_pres: dict[str, PreTreatmentView],
    config: TrajectoryConfig,
) -> TrajectoryFilterResult:
    """Drop controls whose pre-treatment history is the wrong shape.

    If the thresholds would leave too few controls to build anything on, they are
    relaxed: the best `min_controls_retained` by RMSE are kept instead, and the
    result is flagged as relaxed so `model_quality` can lower confidence and the
    interface can say so. Silently returning four controls, or silently returning
    none, are both worse than returning ten weak ones with a warning attached.
    """
    scores = tuple(
        calculate_trajectory_similarity(project_pre, pre, unit_id, config)
        for unit_id, pre in control_pres.items()
    )
    passing = tuple(s.unit_id for s in scores if s.passed)

    if len(passing) >= config.min_controls_retained:
        return TrajectoryFilterResult(kept=passing, scores=scores, relaxed=False)

    ranked = sorted(scores, key=lambda s: s.rmse)
    kept = tuple(s.unit_id for s in ranked[: config.min_controls_retained])
    return TrajectoryFilterResult(
        kept=kept,
        scores=scores,
        relaxed=True,
        note=(
            f"Only {len(passing)} controls met the trajectory thresholds, below the "
            f"floor of {config.min_controls_retained}. The {len(kept)} closest by RMSE "
            f"were kept instead. Pre-treatment fit and confidence are reduced "
            f"accordingly."
        ),
    )
