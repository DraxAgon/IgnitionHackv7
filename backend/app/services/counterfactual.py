"""Stages 12 to 14: turning two forest trajectories into a statement about a
carbon claim.

The arithmetic is deliberately plain. Everything difficult happened upstream in
choosing the controls and fitting the weights; if the final comparison needed
clever handling, that would be a sign something earlier was wrong.

What needs care is not the arithmetic but the words. Each quantity below is a
different thing, and they are routinely conflated in public argument about carbon
credits:

  Counterfactual loss     What comparable land actually did. An estimate, with a
                          confidence interval, of an unobservable quantity.
  Actual project loss     What happened inside the project. Observed.
  Avoided deforestation   The difference. Only as good as the counterfactual.
  Claimed baseline        What the project projected would happen without it.
  Baseline discrepancy    Claimed baseline minus our counterfactual. A difference
                          between a projection and an estimate - not, on its own,
                          evidence of anything improper.
  Supported fraction      How much of the claimed avoided loss our estimate can
                          account for.

The last one is the number a buyer wants and the one most easily overstated. It
is a ratio of an estimate to a claim, so it inherits the full uncertainty of the
counterfactual, and it is never reported here without one.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..utils.stats import safe_divide
from ..utils.temporal import Window
from .forest_service import calculate_loss


@dataclass(frozen=True)
class CounterfactualEstimate:
    """What comparable land did over the observation window."""

    loss: float
    cover_at_start: float
    cover_at_end: float
    window: Window
    annual: tuple[dict, ...]

    def as_dict(self) -> dict:
        return {
            "counterfactual_loss": round(self.loss, 5),
            "synthetic_cover_at_start": round(self.cover_at_start, 5),
            "synthetic_cover_at_end": round(self.cover_at_end, 5),
            "window": [self.window.start, self.window.end],
            "annual": list(self.annual),
        }


def calculate_counterfactual_loss(
    synthetic: dict[int, float], window: Window
) -> CounterfactualEstimate:
    """Loss implied by the synthetic control over the observation window.

    Measured against the synthetic series' *own* level at the start of the
    window, not against the project's. The two differ by the pre-treatment fit
    error, and using the project's level would fold that error into the estimate
    - turning a diagnostic we want to report separately into a silent bias in
    the headline number.

    `window` here is a STOCK window and must run one year past the last year of
    clearing: to capture clearing through 2023 it runs 2016 to 2024, because the
    stock at the start of 2024 is what survived 2023. Passing the flux window by
    mistake silently drops the final year, which understates the counterfactual
    by roughly one year in every N - a bias that points consistently toward
    reporting projects as over-credited.
    """
    if window.start not in synthetic or window.end not in synthetic:
        raise ValueError(
            f"synthetic series does not cover {window.start}-{window.end}; "
            f"it spans {min(synthetic, default=None)}-{max(synthetic, default=None)}"
        )
    start_cover = synthetic[window.start]
    end_cover = synthetic[window.end]
    annual = tuple(
        {
            "year": year,
            "synthetic_cover": round(synthetic[year], 5),
            "cumulative_loss": round(calculate_loss(start_cover, synthetic[year]), 5),
        }
        for year in window.years
    )
    return CounterfactualEstimate(
        loss=calculate_loss(start_cover, end_cover),
        cover_at_start=start_cover,
        cover_at_end=end_cover,
        window=window,
        annual=annual,
    )


@dataclass(frozen=True)
class ImpactEstimate:
    """The project's estimated effect, and how it compares with what was claimed."""

    counterfactual_loss: float
    actual_loss: float
    estimated_avoided: float
    claimed_baseline: float
    claimed_avoided: float
    baseline_difference: float
    relative_baseline_difference: float
    supported_fraction: float | None
    potential_overcrediting: float | None
    ratio_claimed_to_independent: float | None

    def as_dict(self) -> dict:
        return {
            "counterfactual_loss": round(self.counterfactual_loss, 5),
            "actual_project_loss": round(self.actual_loss, 5),
            "estimated_avoided_loss": round(self.estimated_avoided, 5),
            "claimed_baseline_loss": round(self.claimed_baseline, 5),
            "claimed_avoided_loss": round(self.claimed_avoided, 5),
            "baseline_difference": round(self.baseline_difference, 5),
            "relative_baseline_difference": round(self.relative_baseline_difference, 5),
            "supported_fraction": (
                None if self.supported_fraction is None else round(self.supported_fraction, 5)
            ),
            "potential_overcrediting": (
                None
                if self.potential_overcrediting is None
                else round(self.potential_overcrediting, 5)
            ),
            "ratio_claimed_to_independent": (
                None
                if self.ratio_claimed_to_independent is None
                else round(self.ratio_claimed_to_independent, 4)
            ),
        }


def calculate_independent_avoided_loss(counterfactual_loss: float, actual_loss: float) -> float:
    """Avoided deforestation on our estimate, in percentage points of forest.

    Floored at zero. A project whose observed loss exceeds the counterfactual has
    not avoided a negative amount of deforestation in any sense a credit could be
    issued against; the meaningful reading is that no avoided loss is
    demonstrated. The unfloored difference stays available in the fields above so
    the sign is not lost.
    """
    return max(0.0, counterfactual_loss - actual_loss)


def calculate_claimed_avoided_loss(claimed_baseline: float, actual_loss: float) -> float:
    """Avoided deforestation as the project's own figures imply it.

    Computed from the project's baseline against the *observed* loss inside the
    project, which is the same observed number used in our own estimate. Using
    the project's own reported internal loss instead would compare two things
    measured different ways, and any difference between the measurements would
    show up as a discrepancy in the claim.
    """
    return max(0.0, claimed_baseline - actual_loss)


def calculate_potential_overcrediting(
    claimed_avoided: float, estimated_avoided: float
) -> tuple[float | None, float | None]:
    """The share of the claim this analysis can and cannot account for.

    Returns (supported_fraction, potential_overcrediting). Both are None when the
    project claims no avoided deforestation, because the ratio is undefined
    rather than zero and reporting 0% supported for a project that claimed
    nothing would be a fabricated finding.

    Supported fraction is capped at 1.0. A counterfactual above the claimed
    baseline means the project may have been conservative; it does not mean 140%
    of the credits are supported, because credits were only issued against the
    claim. The uncapped ratio is available as `ratio_claimed_to_independent`.

    The word is "potential". This is the fraction of the claim that this model,
    with these controls, over this window, does not account for. That is a
    statistical discrepancy. It is not a finding of fraud, error or bad faith,
    and nothing downstream is permitted to describe it as one.
    """
    if claimed_avoided <= 0:
        return None, None
    supported = min(1.0, safe_divide(estimated_avoided, claimed_avoided, default=0.0))
    return supported, 1.0 - supported


def calculate_impact(
    counterfactual_loss: float, actual_loss: float, claimed_baseline: float
) -> ImpactEstimate:
    """Assemble the full comparison."""
    estimated_avoided = calculate_independent_avoided_loss(counterfactual_loss, actual_loss)
    claimed_avoided = calculate_claimed_avoided_loss(claimed_baseline, actual_loss)
    supported, overcrediting = calculate_potential_overcrediting(
        claimed_avoided, estimated_avoided
    )
    return ImpactEstimate(
        counterfactual_loss=counterfactual_loss,
        actual_loss=actual_loss,
        estimated_avoided=estimated_avoided,
        claimed_baseline=claimed_baseline,
        claimed_avoided=claimed_avoided,
        baseline_difference=claimed_baseline - counterfactual_loss,
        relative_baseline_difference=safe_divide(
            claimed_baseline - counterfactual_loss, claimed_baseline, default=0.0
        ),
        supported_fraction=supported,
        potential_overcrediting=overcrediting,
        ratio_claimed_to_independent=(
            safe_divide(claimed_baseline, counterfactual_loss, default=None)
            if counterfactual_loss > 0
            else None
        ),
    )


def credit_exposure(
    impact: ImpactEstimate, credits_issued: int, price_per_credit: float | None
) -> dict:
    """Credits and value corresponding to the unsupported share of the claim.

    A translation of the fraction above into the units a buyer transacts in, and
    nothing more. It carries every assumption of the counterfactual estimate,
    plus one more: that credits were issued in proportion to claimed avoided
    loss. Real issuance also depends on carbon density, leakage deductions,
    buffer-pool contributions and the vintage schedule, none of which are modelled
    here. Treat it as an order of magnitude, which is why it is reported next to
    the fraction rather than instead of it.
    """
    if impact.potential_overcrediting is None or credits_issued <= 0:
        return {
            "credits_issued": credits_issued,
            "credits_unsupported": None,
            "value_unsupported": None,
            "assumption": "no claimed avoided deforestation to apportion",
        }
    unsupported = int(round(credits_issued * impact.potential_overcrediting))
    return {
        "credits_issued": credits_issued,
        "credits_unsupported": unsupported,
        "value_unsupported": (
            round(unsupported * price_per_credit, 2) if price_per_credit else None
        ),
        "assumption": (
            "Credits assumed issued in proportion to claimed avoided deforestation. "
            "Actual issuance also reflects carbon density, leakage deductions and "
            "buffer-pool contributions, which are not modelled here."
        ),
    }


def divergence_timeline(
    project_stock: dict[int, float],
    synthetic_stock: dict[int, float],
    claimed_baseline: float,
    flux_window: Window,
    claimed_path: tuple[float, ...] | None = None,
) -> list[dict]:
    """Year by year: the claim, the project, and comparable land.

    The question this answers is not "was the baseline wrong" but "when did the
    evidence stop supporting it" - which is the more useful question, because a
    baseline set in year one can look reasonable in year one and be visibly wrong
    by year four while credits are still being issued against it.

    Rows are labelled by *flux* year and report the state at the END of that
    year, which is the stock at the start of the following one. Reporting
    start-of-year stock against a flux-year label is the off-by-one this module's
    conventions exist to prevent: the last row would omit the final year's
    clearing entirely, understating every cumulative loss by one year.

    The claimed path is straight-line unless the project supplied its own.
    Baselines are usually stated as an annual rate, so a straight line is the
    faithful reading of a single headline figure; where a project publishes a
    curve, that curve is used instead. The straight line is scaled so the final
    year reaches the full claimed baseline rather than stopping short of it.
    """
    years = flux_window.years
    n = len(years)
    p_base = project_stock[flux_window.start]
    s_base = synthetic_stock[flux_window.start]

    rows: list[dict] = []
    for i, year in enumerate(years):
        end_of_year = year + 1
        if end_of_year not in project_stock or end_of_year not in synthetic_stock:
            raise ValueError(
                f"the stock series must extend to {end_of_year} to report the end of "
                f"flux year {year}; it stops at {max(project_stock)}"
            )
        if claimed_path is not None and i < len(claimed_path):
            claimed = claimed_path[i]
        else:
            claimed = claimed_baseline * ((i + 1) / n)
        project_loss = calculate_loss(p_base, project_stock[end_of_year])
        synth_loss = calculate_loss(s_base, synthetic_stock[end_of_year])
        rows.append(
            {
                "year": year,
                "project": round(project_stock[end_of_year], 5),
                "synthetic": round(synthetic_stock[end_of_year], 5),
                "project_loss": round(project_loss, 5),
                "counterfactual_loss": round(synth_loss, 5),
                "claimed_loss": round(claimed, 5),
                "claim_vs_counterfactual": (
                    round(safe_divide(synth_loss, claimed, default=1.0), 4)
                    if claimed > 0
                    else None
                ),
            }
        )
    return rows


def first_divergence_year(
    rows: list[dict], ratio_threshold: float = 0.5, consecutive_required: int = 2
) -> dict:
    """The earliest point at which the claim stopped tracking the evidence.

    "Tracking" means comparable land was clearing at least `ratio_threshold` of
    the claimed pace. Two consecutive years below it is the flag, because one
    year below could be weather, a fire season, or an enforcement campaign that
    reverses. Two in a row is a pattern.

    Both parameters are arguments rather than constants because the right values
    depend on how noisy the underlying product is, and a threshold chosen to make
    a particular project flag is not a threshold at all.
    """
    run = 0
    for row in rows:
        ratio = row.get("claim_vs_counterfactual")
        if ratio is None:
            continue
        if ratio < ratio_threshold:
            run += 1
            if run >= consecutive_required:
                return {
                    "first_flag_year": row["year"],
                    "criterion": (
                        f"comparable land clearing below {ratio_threshold:.0%} of the "
                        f"claimed pace for {consecutive_required} consecutive years"
                    ),
                    "years_before_window_end": rows[-1]["year"] - row["year"],
                }
        else:
            run = 0
    return {
        "first_flag_year": None,
        "criterion": (
            f"comparable land clearing below {ratio_threshold:.0%} of the claimed pace "
            f"for {consecutive_required} consecutive years"
        ),
        "years_before_window_end": 0,
    }
