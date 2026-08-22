"""Stage 10: building the counterfactual as a weighted combination of real land.

The idea, from Abadie and Gardeazabal (2003) and Abadie, Diamond and Hainmueller
(2010): no single untreated parcel is a good stand-in for a treated one, but a
weighted average of several can reproduce its pre-treatment behaviour closely.
Fit those weights on the years before treatment, then carry them forward. What
the combination does afterwards is the estimate of what the treated unit would
have done.

Why weights rather than an average. Averaging the matched controls treats a
parcel that tracked the project perfectly and one that barely qualified as
equally informative. The optimiser instead finds the specific mixture that
reproduces the project's history, and reports how well it managed - which is a
diagnostic an average simply cannot produce. If no combination reproduces the
pre-treatment path, that is a fact about how identifiable this project's
counterfactual is, and it should lower confidence rather than being hidden by
taking a mean anyway.

Two constraints do the real work:

  w >= 0     No negative weights. A counterfactual should be an average of real
             land, not an extrapolation built by subtracting one parcel from
             another - which is how a linear model with unconstrained
             coefficients will happily produce forest cover above 100% or below
             zero.

  sum(w) = 1 The synthetic control lives inside the convex hull of the observed
             controls. It cannot invent a rate of deforestation that no real
             parcel exhibited. This is the constraint that makes the estimate
             conservative and defensible, and it is also why a project whose
             pre-treatment behaviour sits outside the range of every available
             control cannot be fitted well - correctly, because in that case we
             genuinely do not have comparable land.

The weights are locked when this module returns. `SyntheticControlFit` is frozen,
its arrays are read-only, and the only function that touches post-treatment data
takes a finished fit as input and cannot alter it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence

import cvxpy as cp
import numpy as np

from ..config import SyntheticControlConfig
from ..models.forest_cell import ForestUnit
from ..utils.normalization import FeatureScaler, weight_vector
from ..utils.stats import correlation, effective_count, mae, rmse
from ..utils.temporal import PreTreatmentView, TemporalLeakError, Window
from . import forest_service as fs


class SyntheticControlError(RuntimeError):
    """The convex programme could not be solved.

    Raised rather than falling back to equal weights. An unsolvable programme
    means something is wrong with the inputs, and quietly substituting a
    different estimator would hide that behind a plausible-looking number.
    """


@dataclass(frozen=True)
class SyntheticControlFit:
    """Locked weights and the evidence for how well they fit.

    Immutable by construction. Once this object exists the weights are final,
    which is the mechanism that keeps post-treatment data out of the estimate:
    the only way to change them is to run the optimisation again, and the
    optimisation cannot see post-treatment years because it is only ever handed
    `PreTreatmentView` objects.
    """

    control_ids: tuple[str, ...]
    weights: np.ndarray
    pre_window: Window
    pre_project: np.ndarray
    pre_synthetic: np.ndarray
    pre_rmse: float
    pre_mae: float
    pre_correlation: float
    covariate_distance: float
    features_used: tuple[str, ...]
    solver: str
    status: str
    covariate_lambda: float
    ridge: float

    def __post_init__(self) -> None:
        # Read-only arrays: a caller holding this object cannot mutate the
        # weights in place, accidentally or otherwise.
        for name in ("weights", "pre_project", "pre_synthetic"):
            arr = getattr(self, name)
            arr.setflags(write=False)
        if len(self.control_ids) != len(self.weights):
            raise ValueError("weight vector does not match the control list")

    @property
    def effective_controls(self) -> float:
        return effective_count(self.weights)

    @property
    def max_weight(self) -> float:
        return float(self.weights.max()) if self.weights.size else 0.0

    @property
    def contributing(self) -> tuple[tuple[str, float], ...]:
        """Controls with non-trivial weight, heaviest first."""
        pairs = [
            (cid, float(w)) for cid, w in zip(self.control_ids, self.weights) if w > 0
        ]
        return tuple(sorted(pairs, key=lambda p: -p[1]))

    def weight_for(self, unit_id: str) -> float:
        try:
            return float(self.weights[self.control_ids.index(unit_id)])
        except ValueError:
            return 0.0

    def quality(self) -> dict:
        return {
            "pre_treatment_rmse": round(self.pre_rmse, 5),
            "pre_treatment_mae": round(self.pre_mae, 5),
            "pre_treatment_correlation": round(self.pre_correlation, 4),
            "covariate_distance": round(self.covariate_distance, 4),
            "effective_controls": round(self.effective_controls, 2),
            "max_single_weight": round(self.max_weight, 4),
            "contributing_controls": len(self.contributing),
            "solver": self.solver,
            "status": self.status,
        }


def _covariate_matrix(
    project_features: Mapping[str, float | None],
    control_features: Sequence[Mapping[str, float | None]],
    scaler: FeatureScaler,
    feature_weights: Mapping[str, float],
) -> tuple[np.ndarray, np.ndarray, tuple[str, ...]]:
    """Standardised covariates for the optimiser's second objective term.

    Restricted to covariates present on the project *and* on every control in the
    set. The matrix form has no way to skip a missing cell for one control only,
    and imputing it would put an invented number into the objective the weights
    are chosen by. Dropping the covariate for everyone is the honest option, and
    the covariates that survive are reported so the loss is visible.
    """
    features = scaler.features
    p_vals, p_mask = scaler.transform_row(project_features)
    rows = [scaler.transform_row(r) for r in control_features]
    if not rows:
        return np.zeros((0, 0)), np.zeros(0), ()

    complete = p_mask.copy()
    for _, mask in rows:
        complete &= mask
    if not complete.any():
        return np.zeros((len(rows), 0)), np.zeros(0), ()

    idx = np.where(complete)[0]
    used = tuple(features[i] for i in idx)
    # sqrt of the configured weight, so that squaring inside the objective
    # applies the weight itself rather than its square.
    scale = np.sqrt(weight_vector(used, feature_weights))
    X = np.vstack([vals[idx] for vals, _ in rows]) * scale
    x_target = p_vals[idx] * scale
    return X, x_target, used


def _solve(problem: cp.Problem, config: SyntheticControlConfig) -> str:
    """Try the configured solvers in order and report which one worked.

    Several are attempted because they fail differently: CLARABEL is the
    accurate default, OSQP is fast on well-conditioned problems, SCS is the most
    tolerant of the near-degenerate cases that arise when many controls are
    nearly identical. Silence about which solver produced a number would make an
    unreproducible result look reproducible, so the winner is recorded.
    """
    available = set(cp.installed_solvers())
    tried: list[str] = []
    for name in config.solver_order:
        if name not in available:
            continue
        try:
            problem.solve(solver=name)
        except (cp.error.SolverError, cp.error.DCPError, ValueError) as exc:
            tried.append(f"{name}: {type(exc).__name__}")
            continue
        if problem.status in ("optimal", "optimal_inaccurate") and problem.variables()[0].value is not None:
            return name
        tried.append(f"{name}: {problem.status}")
    raise SyntheticControlError(
        "no solver produced a usable solution for the synthetic-control programme. "
        f"Attempts: {tried or 'none of the configured solvers are installed'}."
    )


def build_synthetic_control(
    project_pre: PreTreatmentView,
    control_pres: Mapping[str, PreTreatmentView],
    project_features: Mapping[str, float | None],
    control_features: Mapping[str, Mapping[str, float | None]],
    scaler: FeatureScaler,
    feature_weights: Mapping[str, float],
    config: SyntheticControlConfig,
) -> SyntheticControlFit:
    """Fit non-negative weights that reproduce the project's pre-treatment path.

    The objective has three terms:

    Trajectory error
        Mean squared difference between the project's pre-treatment forest path
        and the weighted combination's. Divided by the number of pre-treatment
        years so that `covariate_lambda` means the same thing whether the
        pre-period is five years or fifteen.

    Covariate error
        Weighted squared difference on the standardised static covariates,
        scaled by `covariate_lambda`. Without it the optimiser will pick any
        parcels that happen to trace the same curve, including land with a
        completely different elevation, rainfall and access profile that arrived
        at a similar history by unrelated routes. Such controls fit the past and
        have no reason to track the future.

    Ridge
        A small penalty on the squared weights. Where several controls fit
        equally well the programme is nearly degenerate and the solver's choice
        among them is arbitrary; the ridge breaks that tie toward spreading
        weight rather than concentrating it, which both stabilises the estimate
        and stops one parcel quietly determining a project's verdict.

    Every input is a pre-treatment view or a pre-treatment covariate. There is no
    parameter through which post-treatment data could enter.
    """
    control_ids = tuple(control_pres.keys())
    if len(control_ids) < 2:
        raise SyntheticControlError(
            f"a synthetic control needs at least two donors, got {len(control_ids)}"
        )

    window = project_pre.window
    for cid, pre in control_pres.items():
        if pre.window != window:
            raise TemporalLeakError(
                f"{cid}: pre-treatment window {pre.window} differs from the project's "
                f"{window}. Fitting across mismatched windows would compare years that "
                f"only one side lived through."
            )

    y = np.array(project_pre.vector(), dtype=float)
    C = np.column_stack([np.array(control_pres[cid].vector(), dtype=float) for cid in control_ids])
    n_pre, n_controls = C.shape

    X, x_target, used_features = _covariate_matrix(
        project_features,
        [control_features[cid] for cid in control_ids],
        scaler,
        feature_weights,
    )

    w = cp.Variable(n_controls, nonneg=True)
    objective = cp.sum_squares(C @ w - y) / n_pre
    if config.covariate_lambda > 0 and X.size and X.shape[1] > 0:
        objective = objective + config.covariate_lambda * cp.sum_squares(X.T @ w - x_target) / X.shape[1]
    if config.ridge > 0:
        objective = objective + config.ridge * cp.sum_squares(w)

    problem = cp.Problem(cp.Minimize(objective), [cp.sum(w) == 1])
    solver = _solve(problem, config)

    raw = np.asarray(w.value, dtype=float).ravel()
    # Clean up: clip solver noise below zero, drop dust, renormalise. Without
    # this the reported control list is padded with parcels carrying weights of
    # 1e-9, which reads as "built from 200 controls" when it was built from six.
    raw = np.clip(raw, 0.0, None)
    raw[raw < config.weight_floor] = 0.0
    total = raw.sum()
    if total <= 0:
        raise SyntheticControlError(
            "the optimiser returned an all-zero weight vector; the programme is "
            "degenerate for these inputs"
        )
    weights = raw / total

    synthetic_pre = C @ weights
    covariate_distance = (
        float(np.sqrt(np.mean((X.T @ weights - x_target) ** 2)))
        if X.size and X.shape[1] > 0
        else float("nan")
    )

    return SyntheticControlFit(
        control_ids=control_ids,
        weights=weights,
        pre_window=window,
        pre_project=y,
        pre_synthetic=synthetic_pre,
        pre_rmse=rmse(y, synthetic_pre),
        pre_mae=mae(y, synthetic_pre),
        pre_correlation=correlation(y, synthetic_pre),
        covariate_distance=covariate_distance,
        features_used=used_features,
        solver=solver,
        status=problem.status,
        covariate_lambda=config.covariate_lambda,
        ridge=config.ridge,
    )


def apply_locked_weights(
    fit: SyntheticControlFit,
    units: Mapping[str, ForestUnit],
    window: Window,
    anchor_year: int,
) -> np.ndarray:
    """Stage 11: carry the locked weights into the years after treatment.

    This is the only place post-treatment forest data enters the estimate, and it
    enters through a finished fit that this function cannot modify. The weights
    were chosen without seeing any of it.

    Each control's trajectory is anchored on the same year as the project's, so
    the weighted combination is a like-for-like series rather than a mixture of
    curves normalised at different points.
    """
    missing = [cid for cid in fit.control_ids if cid not in units]
    if missing:
        raise ValueError(
            f"cannot apply weights: units missing for {missing[:5]}"
            f"{' and others' if len(missing) > 5 else ''}"
        )
    matrix = np.column_stack(
        [
            fs.remaining_fraction_vector(units[cid], window, anchor_year=anchor_year)
            for cid in fit.control_ids
        ]
    )
    return matrix @ fit.weights


def synthetic_series(
    fit: SyntheticControlFit,
    units: Mapping[str, ForestUnit],
    window: Window,
    anchor_year: int,
) -> dict[int, float]:
    values = apply_locked_weights(fit, units, window, anchor_year)
    return {year: float(v) for year, v in zip(window.years, values)}
