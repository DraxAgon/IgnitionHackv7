"""Stage 15: how wide a range the counterfactual can honestly support.

A synthetic control produces a single number, and a single number invites a
precision it does not have. The estimate depends on which parcels happened to be
in the donor pool, and a different but equally defensible pool would give a
different answer. The bootstrap measures how much.

The procedure: resample the matched donors with replacement, refit the weights on
pre-treatment data only, apply them to the observed post-treatment years, and
collect the distribution of counterfactual losses. The percentile interval over
that distribution is the reported range.

The temporal firewall survives resampling because each refit goes through exactly
the same optimiser as the headline estimate, and that optimiser only ever receives
pre-treatment views. Using a different or simplified estimator inside the
bootstrap is a common shortcut and a serious error: the interval would then
describe the uncertainty of a model that was never used to produce the estimate.

What this interval covers, and what it does not:

  Covered      Sensitivity to which comparable parcels were available.
  Not covered  Measurement error in the underlying forest product; the
               possibility that the covariates omit something that actually
               drove deforestation; the choice of pre-period, buffer distance
               and feature weights. Those are model-specification risks, and no
               resampling scheme can see them.

So the interval is a lower bound on total uncertainty. That is worth stating
plainly wherever it is displayed, and `describe()` does.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np

from ..config import SyntheticControlConfig, UncertaintyConfig
from ..models.forest_cell import ForestUnit
from ..utils.normalization import FeatureScaler
from ..utils.temporal import PreTreatmentView, Window
from .forest_service import calculate_loss, remaining_fraction_vector
from .synthetic_control import (
    SyntheticControlError,
    build_synthetic_control,
)


@dataclass(frozen=True)
class UncertaintyEstimate:
    """A point estimate and the range around it."""

    estimate: float
    lower: float
    upper: float
    confidence: float
    n_successful: int
    n_attempted: int
    std_error: float
    draws: tuple[float, ...] = ()

    @property
    def width(self) -> float:
        return self.upper - self.lower

    def contains(self, value: float) -> bool:
        return self.lower <= value <= self.upper

    def as_dict(self, include_draws: bool = False) -> dict:
        out = {
            "estimate": round(self.estimate, 5),
            "lower": round(self.lower, 5),
            "upper": round(self.upper, 5),
            "confidence_level": self.confidence,
            "width": round(self.width, 5),
            "standard_error": round(self.std_error, 5),
            "bootstrap_iterations": self.n_attempted,
            "bootstrap_converged": self.n_successful,
        }
        if include_draws:
            out["draws"] = [round(d, 5) for d in self.draws]
        return out

    def describe(self) -> str:
        return (
            f"{self.estimate:.1%} (95% interval {self.lower:.1%} to {self.upper:.1%}, "
            f"from {self.n_successful} bootstrap refits). The interval reflects "
            f"sensitivity to the available control parcels; it does not cover error in "
            f"the underlying forest data or the choice of model."
        )


def bootstrap_uncertainty(
    project_pre: PreTreatmentView,
    control_pres: Mapping[str, PreTreatmentView],
    project_features: Mapping[str, float | None],
    control_features: Mapping[str, Mapping[str, float | None]],
    control_units: Mapping[str, ForestUnit],
    scaler: FeatureScaler,
    feature_weights: Mapping[str, float],
    post_window: Window,
    anchor_year: int,
    sc_config: SyntheticControlConfig,
    config: UncertaintyConfig,
    point_estimate: float,
) -> UncertaintyEstimate:
    """Resample donors, refit, and collect the spread of counterfactual losses.

    Duplicates from sampling with replacement are given distinct keys rather than
    being collapsed. That matters: drawing the same parcel three times should
    triple its chance of carrying the fit, which is precisely the sampling
    variation being measured. Silently deduplicating would turn the bootstrap
    into a subsampling scheme with a systematically narrower interval.

    Refits that fail to solve are counted and excluded rather than retried or
    replaced. A pool that frequently produces degenerate programmes is telling us
    the counterfactual is poorly identified, and `n_successful` carries that
    signal into the quality metrics.
    """
    ids = list(control_pres.keys())
    n = len(ids)
    if n < 3:
        return UncertaintyEstimate(
            estimate=point_estimate,
            lower=point_estimate,
            upper=point_estimate,
            confidence=config.confidence,
            n_successful=0,
            n_attempted=0,
            std_error=float("nan"),
        )

    draw_size = max(3, int(round(n * config.resample_fraction)))
    rng = np.random.default_rng(config.random_seed)
    losses: list[float] = []

    # Post-treatment trajectories are precomputed once. They are not inputs to
    # any refit - they are only touched after that iteration's weights are locked.
    post_vectors = {
        cid: remaining_fraction_vector(control_units[cid], post_window, anchor_year=anchor_year)
        for cid in ids
    }

    for _ in range(config.n_bootstrap):
        picks = rng.integers(0, n, size=draw_size)
        alias_pre: dict[str, PreTreatmentView] = {}
        alias_feats: dict[str, Mapping[str, float | None]] = {}
        alias_post: dict[str, np.ndarray] = {}
        for k, idx in enumerate(picks):
            cid = ids[idx]
            key = f"{cid}#{k}"
            alias_pre[key] = control_pres[cid]
            alias_feats[key] = control_features[cid]
            alias_post[key] = post_vectors[cid]

        try:
            fit = build_synthetic_control(
                project_pre=project_pre,
                control_pres=alias_pre,
                project_features=project_features,
                control_features=alias_feats,
                scaler=scaler,
                feature_weights=feature_weights,
                config=sc_config,
            )
        except (SyntheticControlError, ValueError):
            continue

        matrix = np.column_stack([alias_post[cid] for cid in fit.control_ids])
        series = matrix @ fit.weights
        losses.append(calculate_loss(float(series[0]), float(series[-1])))

    if len(losses) < 20:
        return UncertaintyEstimate(
            estimate=point_estimate,
            lower=float("nan"),
            upper=float("nan"),
            confidence=config.confidence,
            n_successful=len(losses),
            n_attempted=config.n_bootstrap,
            std_error=float("nan"),
            draws=tuple(losses),
        )

    arr = np.array(losses, dtype=float)
    alpha = (1.0 - config.confidence) / 2.0
    return UncertaintyEstimate(
        estimate=point_estimate,
        lower=float(np.quantile(arr, alpha)),
        upper=float(np.quantile(arr, 1.0 - alpha)),
        confidence=config.confidence,
        n_successful=len(losses),
        n_attempted=config.n_bootstrap,
        std_error=float(arr.std(ddof=1)),
        draws=tuple(float(x) for x in arr),
    )


def claim_outside_interval(claimed_baseline: float, interval: UncertaintyEstimate) -> dict:
    """Where the project's claimed baseline sits relative to our interval.

    The most defensible single statement this engine can make about a claim, and
    the one it is careful to phrase as a relationship rather than a verdict. A
    baseline above the upper bound is not "wrong" - it is outside the range this
    analysis can account for, which is a statement about the analysis as much as
    about the claim.

    `standard_deviations_above` is reported only when the bootstrap produced a
    usable standard error, and it is a descriptive distance, not a test
    statistic: the draws are not independent samples from a population, so it
    should not be read as a p-value.
    """
    if not np.isfinite(interval.lower) or not np.isfinite(interval.upper):
        return {
            "position": "unknown",
            "note": "the bootstrap did not converge often enough to place the claim",
        }
    if claimed_baseline > interval.upper:
        position = "above_interval"
        wording = (
            "The submitted baseline falls above the range this analysis can account for."
        )
    elif claimed_baseline < interval.lower:
        position = "below_interval"
        wording = (
            "The submitted baseline falls below the range comparable land suggests, "
            "which is consistent with a conservative baseline."
        )
    else:
        position = "within_interval"
        wording = (
            "The submitted baseline falls within the range comparable land supports."
        )
    out = {
        "position": position,
        "statement": wording,
        "claimed_baseline": round(claimed_baseline, 5),
        "interval": [round(interval.lower, 5), round(interval.upper, 5)],
    }
    if np.isfinite(interval.std_error) and interval.std_error > 0:
        out["standard_deviations_above"] = round(
            (claimed_baseline - interval.estimate) / interval.std_error, 2
        )
        out["standard_deviations_note"] = (
            "Descriptive distance from the bootstrap mean, not a hypothesis test."
        )
    return out
