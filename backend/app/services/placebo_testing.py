"""Stage 17: testing the estimator on land where the answer is already known.

Every other output of this engine is an estimate of something unobservable. That
is uncomfortable, and it is also avoidable in one specific case: take a parcel
that was never treated, pretend a project started on it in some past year, hide
everything after that year from the matching and the optimiser, and build a
counterfactual. Because nothing actually happened to that parcel, its observed
post-treatment history *is* the true counterfactual. The prediction can be
scored against it directly.

This is the only part of the system that produces a hard number about its own
accuracy, which makes it the most important part. A platform that tells buyers a
project's baseline is overstated has to be able to answer "how often is your
counterfactual wrong, and by how much" - and answer it with a distribution
rather than an assurance.

Four metrics, each answering a different question:

  MAE       Typical size of the error, in forest-fraction points.
  RMSE      Same, weighting large errors more - catches an estimator that is
            usually good and occasionally catastrophic.
  Bias      Mean signed error. The one that matters most for crediting: an
            estimator biased low understates every counterfactual and therefore
            reports over-crediting everywhere, including where there is none.
  Coverage  Share of placebos whose true outcome fell inside the 95% interval.
            Should be near 95%. Materially below means the intervals are too
            narrow and every confidence statement is overstated.

A placebo run is not free of assumptions - it inherits the same covariates and
the same pool. It cannot detect a covariate that is missing from the model
entirely. It can, and does, detect an estimator that is systematically biased or
whose intervals are dishonest.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

from ..config import DEFAULT_CONFIG, AnalysisConfig
from ..models.forest_cell import ForestUnit, UnitPool
from ..models.project import CarbonProject, ProjectClaim
from ..models.provenance import DataProvenance, Provenance
from ..utils.stats import bias, mae, rmse
from . import forest_service as fs
from .candidate_filter import InsufficientCandidatesError
from .synthetic_control import SyntheticControlError

PLACEBO_CLAIM = DataProvenance(
    kind=Provenance.SYNTHETIC,
    source="placebo harness",
    note=(
        "A nominal baseline attached so an untreated parcel can be run through the "
        "project pipeline. It describes nothing and no claim-side output of a placebo "
        "run is meaningful."
    ),
)


@dataclass(frozen=True)
class PlaceboResult:
    """One pretend project on land that was never treated."""

    unit_id: str
    pseudo_start_year: int
    predicted_loss: float
    actual_loss: float
    error: float
    pre_treatment_rmse: float
    effective_controls: float
    interval_lower: float
    interval_upper: float
    covered: bool | None
    confidence: str

    def as_dict(self) -> dict:
        return {
            "unit_id": self.unit_id,
            "pseudo_start_year": self.pseudo_start_year,
            "predicted_counterfactual_loss": round(self.predicted_loss, 5),
            "actual_loss": round(self.actual_loss, 5),
            "error": round(self.error, 5),
            "pre_treatment_rmse": round(self.pre_treatment_rmse, 5),
            "effective_controls": round(self.effective_controls, 2),
            "interval": [
                None if not np.isfinite(self.interval_lower) else round(self.interval_lower, 5),
                None if not np.isfinite(self.interval_upper) else round(self.interval_upper, 5),
            ],
            "covered_by_interval": self.covered,
            "confidence": self.confidence,
        }


@dataclass(frozen=True)
class PlaceboSuite:
    results: tuple[PlaceboResult, ...]
    failures: tuple[dict, ...]

    @property
    def n(self) -> int:
        return len(self.results)

    def metrics(self) -> dict:
        """Accuracy of the counterfactual estimator, measured not asserted."""
        if not self.results:
            return {
                "n": 0,
                "note": "no placebo run completed; the estimator is unvalidated on this pool",
            }
        predicted = np.array([r.predicted_loss for r in self.results])
        actual = np.array([r.actual_loss for r in self.results])
        assessed = [r for r in self.results if r.covered is not None]
        coverage = (
            sum(1 for r in assessed if r.covered) / len(assessed) if assessed else None
        )
        errors = predicted - actual
        return {
            "n": len(self.results),
            "n_failed": len(self.failures),
            "mae": round(mae(predicted, actual), 5),
            "rmse": round(rmse(predicted, actual), 5),
            "bias": round(bias(predicted, actual), 5),
            "median_error": round(float(np.median(errors)), 5),
            "p90_absolute_error": round(float(np.quantile(np.abs(errors), 0.9)), 5),
            "interval_coverage": None if coverage is None else round(coverage, 4),
            "interval_coverage_n": len(assessed),
            "mean_actual_loss": round(float(actual.mean()), 5),
            "mean_predicted_loss": round(float(predicted.mean()), 5),
            "interpretation": _interpret(errors, coverage),
        }

    def as_dict(self, include_runs: bool = False) -> dict:
        out = {"metrics": self.metrics(), "failures": list(self.failures)}
        if include_runs:
            out["runs"] = [r.as_dict() for r in self.results]
        return out


def _interpret(errors: np.ndarray, coverage: float | None) -> list[str]:
    lines: list[str] = []
    mean_error = float(errors.mean())
    if abs(mean_error) < 0.005:
        lines.append(
            f"Mean signed error {mean_error:+.3%} of forest cover - no material bias "
            f"in either direction."
        )
    elif mean_error < 0:
        lines.append(
            f"The estimator runs {abs(mean_error):.3%} low on average. A counterfactual "
            f"biased low understates avoided deforestation and will report "
            f"over-crediting even where none exists. Treat supported-fraction figures "
            f"as conservative until this is corrected."
        )
    else:
        lines.append(
            f"The estimator runs {mean_error:+.3%} high on average, which would flatter "
            f"projects by overstating what comparable land lost."
        )
    if coverage is not None:
        if coverage < 0.85:
            lines.append(
                f"Only {coverage:.0%} of true outcomes fell inside the nominal 95% "
                f"interval. The intervals are too narrow and every confidence statement "
                f"built on them overstates precision."
            )
        elif coverage > 0.99:
            lines.append(
                f"{coverage:.0%} coverage against a nominal 95% - the intervals are "
                f"wider than they need to be, which is the safe direction but costs "
                f"discriminating power."
            )
        else:
            lines.append(f"Interval coverage {coverage:.0%} against a nominal 95%.")
    return lines


def _as_placebo_project(unit: ForestUnit, pseudo_start_year: int, crediting_years: int) -> CarbonProject:
    """Wrap an untreated parcel so it can run through the project pipeline.

    Running placebos through the *same* pipeline as real projects is the whole
    point. A separate simplified path would validate a different estimator than
    the one in production, which is the most common way a backtest ends up
    reassuring rather than informative.
    """
    return CarbonProject(
        project_id=f"PLACEBO-{unit.unit_id}-{pseudo_start_year}",
        name=f"Placebo on {unit.label or unit.unit_id}",
        short_name=f"placebo {unit.unit_id}",
        start_year=pseudo_start_year,
        crediting_years=crediting_years,
        footprint=unit,
        host_unit_id=unit.unit_id,
        country=unit.country,
        claim=ProjectClaim(
            baseline_loss=0.10,
            credits_issued=0,
            methodology="placebo",
            registry="none",
            provenance=PLACEBO_CLAIM,
        ),
    )


def run_placebo_test(
    unit: ForestUnit,
    pool: UnitPool,
    pseudo_start_year: int,
    config: AnalysisConfig = DEFAULT_CONFIG,
    crediting_years: int = 8,
    include_bootstrap: bool = False,
) -> PlaceboResult:
    """One placebo: predict an untreated parcel's future, then check it.

    The parcel is removed from its own donor pool, and the ordinary leakage
    buffer removes its neighbours as well. Both matter - a synthetic control
    allowed to include the unit it is predicting would reproduce it perfectly and
    prove nothing.
    """
    from .pipeline import run_project_analysis

    project = _as_placebo_project(unit, pseudo_start_year, crediting_years)
    result = run_project_analysis(
        project,
        pool.excluding(unit.unit_id),
        config=config,
        include_bootstrap=include_bootstrap,
    )

    window = result.timing.effective_post
    actual = fs.loss_fraction(unit, window.start, window.end)
    predicted = result.counterfactual.loss
    covered = (
        None
        if not np.isfinite(result.interval.lower) or not np.isfinite(result.interval.upper)
        else bool(result.interval.lower <= actual <= result.interval.upper)
    )
    return PlaceboResult(
        unit_id=unit.unit_id,
        pseudo_start_year=pseudo_start_year,
        predicted_loss=predicted,
        actual_loss=actual,
        error=predicted - actual,
        pre_treatment_rmse=result.fit.pre_rmse,
        effective_controls=result.fit.effective_controls,
        interval_lower=result.interval.lower,
        interval_upper=result.interval.upper,
        covered=covered,
        confidence=result.quality.confidence,
    )


def run_placebo_suite(
    pool: UnitPool,
    pseudo_start_years: Sequence[int],
    config: AnalysisConfig = DEFAULT_CONFIG,
    max_units: int | None = None,
    min_forest_km2: float = 500.0,
    max_protected_fraction: float = 0.25,
    crediting_years: int = 8,
    include_bootstrap: bool = False,
) -> PlaceboSuite:
    """Run placebos across many parcels and start years.

    Candidates are restricted to the same kind of land that would qualify as a
    control - unprotected and substantially forested - so the measured accuracy
    describes the population the estimator is actually used on. Scoring it on
    parcels that could never be controls would produce a number that is true and
    irrelevant.

    Failures are collected rather than raised. A pool where a third of placebos
    cannot be fitted is telling us something real about how identifiable these
    counterfactuals are, and that belongs in the report next to the accuracy.
    """
    eligible = [
        u
        for u in pool.units
        if not u.is_carbon_project
        and u.protected_fraction <= max_protected_fraction
        and u.forest_baseline_km2 >= min_forest_km2
    ]
    eligible.sort(key=lambda u: u.unit_id)
    if max_units is not None:
        eligible = eligible[:max_units]

    results: list[PlaceboResult] = []
    failures: list[dict] = []
    for unit in eligible:
        for year in pseudo_start_years:
            try:
                results.append(
                    run_placebo_test(
                        unit,
                        pool,
                        year,
                        config=config,
                        crediting_years=crediting_years,
                        include_bootstrap=include_bootstrap,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - every failure mode is reportable
                failures.append(
                    {
                        "unit_id": unit.unit_id,
                        "pseudo_start_year": year,
                        "error": type(exc).__name__,
                        "detail": str(exc)[:200],
                    }
                )
    return PlaceboSuite(results=tuple(results), failures=tuple(failures))
