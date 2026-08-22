"""The finished analysis, and its translation into the JSON the frontend renders.

Two responsibilities, kept apart on purpose. `AnalysisResult` holds the real
objects - fits, intervals, matches - so that a notebook or a test can reach into
any of them. `as_api_dict` flattens that into transport, and is the only place
that decides what a client sees.

The interpretation rules live here rather than in the frontend. A caller that
renders these fields directly cannot accidentally describe a discrepancy as
fraud, because the wording ships with the numbers and the numbers that would need
a caveat arrive carrying one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from ..services.candidate_filter import CandidatePool
from ..services.control_matching import ControlMatch, MatchingResult
from ..services.counterfactual import CounterfactualEstimate, ImpactEstimate
from ..services.model_quality import ModelQuality
from ..services.risk_scoring import RiskAssessment
from ..services.synthetic_control import SyntheticControlFit
from ..services.trajectory import TrajectoryFilterResult
from ..services.uncertainty import UncertaintyEstimate
from ..utils.temporal import TreatmentTiming
from .project import CarbonProject
from .provenance import ResultProvenance


def interpretation(
    impact: ImpactEstimate, quality: ModelQuality, interval: UncertaintyEstimate
) -> list[str]:
    """Plain-language readings of the result, phrased as findings about the model.

    Every sentence is a statement about what this analysis estimates, not about
    what a project did. That is not only a legal precaution - it is the
    accurate framing. The counterfactual is unobservable; we have an estimate of
    it from comparable land, and the honest claim is always of the form "our
    estimate supports X of the claim", never "the project overstated X".
    """
    lines: list[str] = []

    if impact.supported_fraction is not None:
        lines.append(
            f"Independent counterfactual analysis supports approximately "
            f"{impact.supported_fraction:.0%} of the avoided deforestation this project "
            f"claims over the window analysed."
        )
    else:
        lines.append(
            "The project claims no avoided deforestation over the window analysed, so "
            "there is no claim for this analysis to apportion."
        )

    if impact.baseline_difference > 0:
        lines.append(
            f"The submitted baseline of {impact.claimed_baseline:.1%} is "
            f"{abs(impact.baseline_difference) * 100:.1f} percentage points above the "
            f"{impact.counterfactual_loss:.1%} that comparable untreated forest actually "
            f"lost over the same period. This is a discrepancy between a projection and "
            f"an estimate, and is not in itself evidence of error or misconduct."
        )
    else:
        lines.append(
            f"The submitted baseline of {impact.claimed_baseline:.1%} is at or below the "
            f"{impact.counterfactual_loss:.1%} that comparable untreated forest lost over "
            f"the same period, which is consistent with a conservative baseline."
        )

    lines.append(
        f"Estimated counterfactual loss {interval.estimate:.1%}, 95% interval "
        f"{interval.lower:.1%} to {interval.upper:.1%}. The counterfactual cannot be "
        f"observed; this range reflects sensitivity to which comparable parcels were "
        f"available, and does not cover error in the underlying forest data."
    )

    if quality.confidence != "HIGH":
        lines.append(
            f"Model confidence is {quality.confidence}. "
            + " ".join(quality.warnings[:2])
        )
    return lines


@dataclass(frozen=True)
class AnalysisResult:
    """Everything one run of the pipeline produced."""

    project: CarbonProject
    timing: TreatmentTiming
    provenance: ResultProvenance

    initial_forest: Mapping[str, Any]
    observed: Mapping[str, Any]
    counterfactual: CounterfactualEstimate
    impact: ImpactEstimate
    interval: UncertaintyEstimate
    claim_position: Mapping[str, Any]
    credits: Mapping[str, Any]

    fit: SyntheticControlFit
    matching: MatchingResult
    candidates: CandidatePool
    trajectory_filter: TrajectoryFilterResult
    quality: ModelQuality
    risk: RiskAssessment

    project_series: Mapping[int, float]
    synthetic_series: Mapping[int, float]
    timeline: Sequence[Mapping[str, Any]]
    divergence: Mapping[str, Any]
    balance: Sequence[Mapping[str, Any]]
    features_used: tuple[str, ...]
    config_snapshot: Mapping[str, Any] = field(default_factory=dict)

    # -- views --------------------------------------------------------------

    def contributing_controls(self) -> list[dict]:
        """Matched controls with their synthetic weights, heaviest first.

        Includes every matched control, with a weight of zero where the optimiser
        did not use it. The zero-weight ones matter: they are the parcels that
        looked similar enough to qualify and were still not needed, which is part
        of showing that the donor pool was not cherry-picked.
        """
        by_id: dict[str, ControlMatch] = {m.unit_id: m for m in self.matching.matches}
        rows = []
        for unit_id, weight in self.fit.contributing:
            match = by_id.get(unit_id)
            if match is None:
                continue
            row = match.as_dict()
            row["synthetic_weight"] = round(weight, 5)
            rows.append(row)
        used = {r["id"] for r in rows}
        for match in self.matching.matches:
            if match.unit_id in used:
                continue
            row = match.as_dict()
            row["synthetic_weight"] = 0.0
            rows.append(row)
        return rows

    def interpretation(self) -> list[str]:
        return interpretation(self.impact, self.quality, self.interval)

    def as_api_dict(self, include_zero_weight_controls: bool = True) -> dict:
        """The response shape the frontend renders.

        Provenance and caveats are top-level rather than nested in a footnote,
        because a client that ignores them will otherwise present an illustrative
        claim as a finding, and the most likely client is a chart.
        """
        controls = self.contributing_controls()
        if not include_zero_weight_controls:
            controls = [c for c in controls if c["synthetic_weight"] > 0]

        return {
            "project": {
                "id": self.project.project_id,
                "name": self.project.name,
                "short_name": self.project.display_name,
                "start_year": self.project.start_year,
                "registry": self.project.claim.registry,
                "methodology": self.project.claim.methodology,
                "country": self.project.country,
                "centroid": {
                    "lat": round(self.project.centroid[1], 5),
                    "lng": round(self.project.centroid[0], 5),
                },
                "geometry": self.project.geometry,
                "area_ha": self.project.area_ha,
            },
            "analysis_window": {
                "pre_treatment": [self.timing.pre_period.start, self.timing.pre_period.end],
                "observation": [
                    self.timing.effective_post.start,
                    self.timing.effective_post.end,
                ],
                "cutoff_year": self.timing.cutoff_year,
                "is_backtest": self.timing.is_backtest,
            },
            "provenance": {
                "measurement": self.provenance.measurement.describe(),
                "claim": self.provenance.claim.describe(),
                "is_finding": self.provenance.is_finding,
                "caveat": self.provenance.caveat,
                "citation": self.provenance.measurement.citation,
            },
            "official": {
                "claimed_baseline_loss": round(self.project.claim.baseline_loss, 5),
                "claimed_credits": self.project.claim.credits_issued,
                "credits_retired": self.project.claim.credits_retired,
            },
            "initial_forest": dict(self.initial_forest),
            "observed": {
                "project_loss": round(float(self.observed["loss_fraction"]), 5),
                "initial_forest_ha": self.observed["initial_forest_ha"],
                "cleared_ha": self.observed["cleared_ha"],
                "annual": self.observed["annual"],
                "caveat": self.observed["disturbance_caveat"],
            },
            "independent_analysis": {
                **self.counterfactual.as_dict(),
                "counterfactual_ci": {
                    "lower": round(self.interval.lower, 5),
                    "upper": round(self.interval.upper, 5),
                    "confidence_level": self.interval.confidence,
                },
                "estimated_avoided_loss": round(self.impact.estimated_avoided, 5),
                "uncertainty": self.interval.as_dict(),
                "claim_position": dict(self.claim_position),
            },
            "comparison": self.impact.as_dict(),
            "credit_exposure": dict(self.credits),
            "model_quality": self.quality.as_dict(),
            "synthetic_control": {
                **self.fit.quality(),
                "covariate_lambda": self.fit.covariate_lambda,
                "features_in_objective": list(self.fit.features_used),
                "weights_locked_before_observation": True,
            },
            "matching": {
                "features_used": list(self.features_used),
                "candidate_pool": self.candidates.summary(),
                "shortlist": self.matching.summary(),
                "trajectory_filter": self.trajectory_filter.summary(),
                "covariate_balance": list(self.balance),
            },
            "risk": self.risk.as_dict(),
            "timeseries": list(self.timeline),
            "divergence": dict(self.divergence),
            "controls": controls,
            "interpretation": self.interpretation(),
            "config": dict(self.config_snapshot),
        }
