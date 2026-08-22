"""Small statistical primitives, kept in one place so they behave identically
wherever they are used.

Nothing here is clever. It exists because subtly different quantile conventions
or a correlation that returns NaN on a flat series are exactly the kind of thing
that makes two parts of an analysis disagree without anyone noticing.
"""

from __future__ import annotations

import numpy as np


def quantile(values: np.ndarray | list[float], q: float) -> float:
    """Linear-interpolated quantile, matching numpy's default convention."""
    arr = np.asarray(values, dtype=float)
    if arr.size == 0:
        return float("nan")
    return float(np.quantile(arr, q))


def rmse(a: np.ndarray, b: np.ndarray) -> float:
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    return float(np.sqrt(np.mean((a - b) ** 2)))


def mae(a: np.ndarray, b: np.ndarray) -> float:
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    return float(np.mean(np.abs(a - b)))


def bias(predicted: np.ndarray, actual: np.ndarray) -> float:
    """Mean signed error. Positive means the prediction runs high.

    Reported separately from RMSE because they answer different questions: RMSE
    says how wrong the model is, bias says whether it is wrong in a consistent
    direction. A counterfactual estimator with low RMSE and high bias is still
    systematically over- or under-crediting every project it touches.
    """
    p, a = np.asarray(predicted, dtype=float), np.asarray(actual, dtype=float)
    return float(np.mean(p - a))


def correlation(a: np.ndarray, b: np.ndarray) -> float:
    """Pearson correlation, returning 0.0 rather than NaN for a flat series.

    A parcel that lost nothing for eight years has zero variance, so correlation
    with it is undefined. Treating that as "no relationship" is the honest
    reading and keeps a NaN from silently propagating into a similarity score.
    """
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    if a.size < 2 or b.size < 2:
        return 0.0
    sa, sb = a.std(), b.std()
    if sa < 1e-12 or sb < 1e-12:
        return 0.0
    return float(np.clip(np.corrcoef(a, b)[0, 1], -1.0, 1.0))


def ols_slope(y: np.ndarray, x: np.ndarray | None = None) -> float:
    """Least-squares slope of y against x (default: 0, 1, 2, ...)."""
    y = np.asarray(y, dtype=float)
    if y.size < 2:
        return 0.0
    x = np.arange(y.size, dtype=float) if x is None else np.asarray(x, dtype=float)
    xm, ym = x.mean(), y.mean()
    denom = float(((x - xm) ** 2).sum())
    if denom < 1e-12:
        return 0.0
    return float(((x - xm) * (y - ym)).sum() / denom)


def safe_divide(numerator: float, denominator: float, default: float = 0.0) -> float:
    """Division that returns `default` instead of exploding on a zero denominator.

    Used for loss fractions, where a unit with no standing forest has no
    meaningful loss *rate* - the honest answer is "undefined", and zero is the
    least misleading stand-in once such units have already been filtered out.
    """
    if abs(denominator) < 1e-12:
        return default
    return float(numerator / denominator)


def effective_count(weights: np.ndarray) -> float:
    """Inverse Herfindahl index: how many controls are *really* contributing.

    A synthetic control with weights (0.97, 0.01, 0.01, 0.01) nominally uses four
    parcels but is one parcel wearing a disguise. This returns 1.06 for that
    case and 4.0 for equal weights, which is the number that should be reported
    next to any claim about how many controls back an estimate.
    """
    w = np.asarray(weights, dtype=float)
    s = w.sum()
    if s <= 0:
        return 0.0
    w = w / s
    denom = float((w ** 2).sum())
    return float(1.0 / denom) if denom > 0 else 0.0
