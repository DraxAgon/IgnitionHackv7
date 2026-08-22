"""Stage 19: rolling the analysis up into a screening score, transparently.

A composite score is a presentation device. It is not a statistic, it has no
sampling distribution, and no amount of arithmetic turns the weighted sum of a
percentage and a ratio into a measurement. This module therefore does two things
in a fixed order: it reports the raw components, each of which means something on
its own, and only then combines them - having said exactly how.

The design differs from the obvious one in a way worth flagging. It is tempting
to treat "pre-treatment fit" and "control match quality" as risk components and
add them in alongside baseline divergence. That produces a score that rises when
the model is good, which is incoherent: a well-fitted model that finds a
project's baseline entirely reasonable would score as higher risk than a badly
fitted one that found the same thing.

So there are two distinct roles:

  Signal      How far the submitted baseline sits from what comparable land did,
              and whether it falls outside the interval this analysis supports.
              Only these carry risk.

  Confidence  Pre-treatment fit, control quality, bootstrap behaviour. These
              never create risk. They scale it - a weak model pulls the score
              toward neutral, because a weak model is weak evidence in either
              direction.

The output is a screening prompt: which projects deserve a closer look, in what
order. It is not a verdict about any project, and the wording throughout says so.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..config import RiskConfig
from .counterfactual import ImpactEstimate
from .model_quality import ModelQuality
from .uncertainty import UncertaintyEstimate


@dataclass(frozen=True)
class RiskComponent:
    """One transparent input to the score."""

    name: str
    label: str
    score: float
    role: str
    explanation: str

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "score": round(self.score, 1),
            "role": self.role,
            "explanation": self.explanation,
        }


@dataclass(frozen=True)
class RiskAssessment:
    score: float
    level: str
    components: tuple[RiskComponent, ...]
    confidence_multiplier: float
    raw_signal: float
    method: str
    caveat: str

    def as_dict(self) -> dict:
        return {
            "score": round(self.score, 1),
            "level": self.level,
            "raw_signal_before_confidence": round(self.raw_signal, 1),
            "confidence_multiplier": round(self.confidence_multiplier, 3),
            "components": [c.as_dict() for c in self.components],
            "method": self.method,
            "caveat": self.caveat,
        }


def divergence_component(impact: ImpactEstimate) -> RiskComponent:
    """How much of the claimed avoided deforestation this analysis accounts for.

    Scored directly from the unsupported share, which is already a fraction on
    [0, 1] with a plain meaning - no rescaling, no curve. A project whose claim is
    fully accounted for scores 0; one where none of it is accounted for scores
    100.

    When a project claimed no avoided deforestation the ratio is undefined, and
    the component is neutral rather than zero. Zero would read as "verified
    consistent", which is a different and unearned statement.
    """
    if impact.potential_overcrediting is None:
        return RiskComponent(
            name="baseline_divergence",
            label="Unsupported share of claim",
            score=50.0,
            role="signal",
            explanation=(
                "The project claims no avoided deforestation over this window, so there "
                "is no claim to apportion. Scored neutral rather than clear."
            ),
        )
    score = float(np.clip(impact.potential_overcrediting * 100.0, 0.0, 100.0))
    return RiskComponent(
        name="baseline_divergence",
        label="Unsupported share of claim",
        score=score,
        role="signal",
        explanation=(
            f"Independent counterfactual {impact.counterfactual_loss:.1%} against a "
            f"submitted baseline of {impact.claimed_baseline:.1%}. Of the "
            f"{impact.claimed_avoided:.1%} of claimed avoided deforestation, this "
            f"analysis accounts for {impact.supported_fraction:.0%}."
        ),
    )


def interval_separation_component(
    claimed_baseline: float, interval: UncertaintyEstimate
) -> RiskComponent:
    """Whether the claim sits outside the range this analysis supports, and by how far.

    Scored on the gap between the claim and the interval's upper bound, measured
    in units of the interval's own half-width. That normalisation is what makes
    the number mean something: exceeding a tight interval by two points is a
    stronger signal than exceeding a wide one by the same two points, and a raw
    difference cannot tell them apart.

      claim inside the interval          0
      claim one half-width above it     50
      claim two half-widths above      100

    A claim *below* the interval scores 0. Conservative baselines are not a
    crediting-integrity risk of this kind, and this engine is not built to
    penalise them.
    """
    if not np.isfinite(interval.lower) or not np.isfinite(interval.upper):
        return RiskComponent(
            name="interval_separation",
            label="Claim against supported range",
            score=50.0,
            role="signal",
            explanation="The bootstrap did not converge often enough to place the claim.",
        )
    half_width = max((interval.upper - interval.lower) / 2.0, 1e-4)
    excess = (claimed_baseline - interval.upper) / half_width
    score = float(np.clip(excess * 50.0, 0.0, 100.0))
    if claimed_baseline <= interval.upper:
        wording = (
            f"The submitted baseline of {claimed_baseline:.1%} falls within the range "
            f"this analysis supports ({interval.lower:.1%} to {interval.upper:.1%})."
        )
    else:
        wording = (
            f"The submitted baseline of {claimed_baseline:.1%} falls above the upper "
            f"bound of the supported range ({interval.upper:.1%}), by "
            f"{excess:.1f} half-widths of the interval."
        )
    return RiskComponent(
        name="interval_separation",
        label="Claim against supported range",
        score=score,
        role="signal",
        explanation=wording,
    )


def confidence_components(quality: ModelQuality) -> tuple[RiskComponent, ...]:
    """Model-quality figures, reported as confidence rather than as risk.

    Carried in the output so a reader can see everything that shaped the score,
    with `role` marking that these scale the signal instead of contributing to
    it.
    """
    return (
        RiskComponent(
            name="pre_treatment_fit",
            label="Pre-treatment fit",
            score=quality.pre_treatment_fit * 100.0,
            role="confidence",
            explanation=(
                f"The weighted controls reproduce the project's pre-treatment forest "
                f"path with an RMSE of {quality.pre_treatment_rmse:.4f}. Higher is "
                f"better and increases confidence in the estimate, in either direction."
            ),
        ),
        RiskComponent(
            name="control_match_quality",
            label="Control match quality",
            score=quality.control_match_quality * 100.0,
            role="confidence",
            explanation=(
                f"Built from covariate closeness, an effective "
                f"{quality.effective_controls:.1f} contributing controls, and a largest "
                f"single weight of {quality.max_single_weight:.0%}."
            ),
        ),
        RiskComponent(
            name="estimate_precision",
            label="Estimate precision",
            score=(
                float(np.clip(100.0 * (1.0 - min(quality.interval_width or 1.0, 0.2) / 0.2), 0, 100))
            ),
            role="confidence",
            explanation=(
                f"95% interval spans {quality.interval_width:.1%} of forest cover."
                if quality.interval_width is not None
                else "No usable interval was produced."
            ),
        ),
    )


def calculate_risk_metrics(
    impact: ImpactEstimate,
    interval: UncertaintyEstimate,
    quality: ModelQuality,
    config: RiskConfig,
) -> RiskAssessment:
    """Combine signal and confidence into a screening score.

    signal      = 0.60 * unsupported share of claim
                + 0.40 * separation between claim and supported range

    multiplier  = 0.35 + 0.65 * mean(pre-treatment fit, control quality)

    score       = signal * multiplier

    The multiplier floor means a weak model can shrink a strong signal to about a
    third, but never to nothing: poor model quality is a reason to look harder at
    a project, not a reason to stop looking. The weights are a presentation
    choice and are configurable; the components underneath them are the part
    worth reading, and both are returned.
    """
    divergence = divergence_component(impact)
    separation = interval_separation_component(impact.claimed_baseline, interval)
    confidence = confidence_components(quality)

    signal = (
        config.weight_divergence * divergence.score
        + config.weight_ci_separation * separation.score
    ) / max(config.weight_divergence + config.weight_ci_separation, 1e-9)

    fit_and_quality = np.mean(
        [quality.pre_treatment_fit, quality.control_match_quality]
    )
    floor = config.min_confidence_multiplier
    multiplier = float(floor + (1.0 - floor) * np.clip(fit_and_quality, 0.0, 1.0))
    score = float(np.clip(signal * multiplier, 0.0, 100.0))

    level = next(
        (name for name, threshold in config.band_thresholds if score >= threshold),
        "CONSISTENT",
    )

    return RiskAssessment(
        score=score,
        level=level,
        components=(divergence, separation, *confidence),
        confidence_multiplier=multiplier,
        raw_signal=signal,
        method=(
            "score = (0.60 * unsupported share + 0.40 * interval separation) * "
            "(0.35 + 0.65 * mean(pre-treatment fit, control match quality)). "
            "Signal components measure the discrepancy; confidence components only "
            "scale it. Every component is reported separately above."
        ),
        caveat=(
            "This is a screening score for prioritising review, not a finding about any "
            "project. It reports a statistical discrepancy between a submitted baseline "
            "and an independently estimated counterfactual, both of which carry "
            "uncertainty. It is not evidence of error, misconduct or bad faith by any "
            "party."
        ),
    )
