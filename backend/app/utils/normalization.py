"""Putting covariates on a common footing before they are compared.

Elevation is in metres, forest cover is a fraction, population density is people
per square kilometre. Comparing them raw means the covariate with the largest
numbers decides every match, which for this feature set would be elevation - a
variable we have deliberately given one of the lowest weights.

Standardisation fixes the units. Weighting then restores the *intended*
hierarchy on top of it, which is the point: after scaling, a one-standard-
deviation difference in prior clearing rate should count for more than a
one-standard-deviation difference in altitude, because it predicts far more.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np


@dataclass(frozen=True)
class FeatureScaler:
    """Per-feature centre and spread, fitted on a candidate pool.

    Fitted on the pool rather than on the pool-plus-project, so that adding a
    project cannot shift the scale against which every control is judged. With
    hundreds of controls the difference is tiny; the guarantee that the yardstick
    does not move is worth more than the difference.
    """

    features: tuple[str, ...]
    mean: np.ndarray
    scale: np.ndarray
    coverage: np.ndarray

    @classmethod
    def fit(cls, rows: Sequence[Mapping[str, float | None]], features: Sequence[str]) -> "FeatureScaler":
        features = tuple(features)
        means, scales, coverage = [], [], []
        n = max(len(rows), 1)
        for name in features:
            vals = np.array(
                [r.get(name) for r in rows if r.get(name) is not None and np.isfinite(r.get(name))],
                dtype=float,
            )
            coverage.append(len(vals) / n)
            if vals.size == 0:
                means.append(0.0)
                scales.append(1.0)
                continue
            m = float(vals.mean())
            s = float(vals.std())
            # A constant covariate carries no information. Scale of 1 leaves its
            # standardised value at 0 for everyone, contributing nothing to any
            # distance rather than dividing by ~0 and dominating all of them.
            means.append(m)
            scales.append(s if s > 1e-12 else 1.0)
        return cls(
            features=features,
            mean=np.array(means, dtype=float),
            scale=np.array(scales, dtype=float),
            coverage=np.array(coverage, dtype=float),
        )

    def transform_row(self, row: Mapping[str, float | None]) -> tuple[np.ndarray, np.ndarray]:
        """Standardise one unit's covariates.

        Returns (values, mask). The mask marks which covariates were actually
        present. Missing values are *not* imputed to the mean: an unmeasured
        elevation is not an average elevation, and quietly filling it in would
        manufacture similarity that the data does not support. Callers skip
        masked-out covariates instead.
        """
        vals = np.zeros(len(self.features), dtype=float)
        mask = np.zeros(len(self.features), dtype=bool)
        for i, name in enumerate(self.features):
            v = row.get(name)
            if v is None or not np.isfinite(v):
                continue
            vals[i] = (float(v) - self.mean[i]) / self.scale[i]
            mask[i] = True
        return vals, mask

    def transform(self, rows: Sequence[Mapping[str, float | None]]) -> tuple[np.ndarray, np.ndarray]:
        out = [self.transform_row(r) for r in rows]
        if not out:
            return np.zeros((0, len(self.features))), np.zeros((0, len(self.features)), dtype=bool)
        return np.vstack([o[0] for o in out]), np.vstack([o[1] for o in out])

    def available_features(self, min_coverage: float = 0.5) -> tuple[str, ...]:
        """Features measured on enough of the pool to be worth matching on."""
        return tuple(f for f, c in zip(self.features, self.coverage) if c >= min_coverage)


def weight_vector(features: Sequence[str], weights: Mapping[str, float]) -> np.ndarray:
    """Look up configured weights, defaulting to 1.0 for anything unlisted."""
    return np.array([float(weights.get(f, 1.0)) for f in features], dtype=float)


def weighted_distance(
    a_vals: np.ndarray,
    a_mask: np.ndarray,
    b_vals: np.ndarray,
    b_mask: np.ndarray,
    weights: np.ndarray,
) -> float:
    """Weighted Euclidean distance over the covariates both units actually have.

    This is a diagonal Mahalanobis distance: standardised, weighted, and with no
    off-diagonal terms. Correlations between covariates are therefore ignored,
    which slightly over-counts information shared between, say, prior clearing
    and road distance. A full covariance would fix that and is a defensible
    upgrade; it is not the default because with a pool of a few hundred units the
    estimated covariance is noisy enough to do more harm than the bias it removes.

    Normalising by the summed weight of the *used* covariates - not by their
    count - keeps distances comparable between a unit measured on all twelve
    covariates and one measured on nine.
    """
    both = a_mask & b_mask
    if not both.any():
        return float("inf")
    diff = (a_vals - b_vals)[both]
    w = weights[both]
    return float(np.sqrt(np.sum(w * diff ** 2) / np.sum(w)))


def similarity_from_distance(distance: float) -> float:
    """Map a distance onto a 0-1 similarity for display.

    exp(-d/2), so a distance of 0 reads as 1.00, one weighted standard deviation
    of average mismatch reads as 0.61, and two read as 0.37. This is a monotone
    relabelling for the interface and carries no extra information - every
    threshold in the engine is applied to the distance itself.
    """
    if not np.isfinite(distance):
        return 0.0
    return float(np.exp(-distance / 2.0))


def standardized_difference(
    treated: float | None, control_values: np.ndarray, pooled_sd: float
) -> float:
    """Standardised mean difference, the usual covariate-balance diagnostic.

    Reported per covariate before and after matching. The convention in the
    matching literature is that |SMD| below 0.1 is good balance and below 0.25 is
    tolerable; those thresholds are what `model_quality` reports against.
    """
    if treated is None or not np.isfinite(treated) or control_values.size == 0 or pooled_sd <= 0:
        return float("nan")
    return float((treated - float(np.mean(control_values))) / pooled_sd)
