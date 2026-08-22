"""Tunable parameters for the analysis, in one place and nowhere else.

Every number here changes what the engine concludes, so none of them are buried
inside the algorithm. Each carries the reasoning for its default; where a
defensible value comes from published practice that is said explicitly, and
where it is a judgement call for this dataset that is said too.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Mapping

# ── covariates used for matching ───────────────────────────────────────────
# All measurable before a project starts. Nothing derived from the outcome
# window appears here, and `test_temporal_integrity` fails the build if it does.

FEATURES: tuple[str, ...] = (
    "forest_cover",
    "historical_loss_rate",
    "historical_loss_trend",
    "prior_cleared_fraction",
    "elevation",
    "slope",
    "distance_to_road",
    "distance_to_settlement",
    "population_density",
    "cropland_percentage",
    "precipitation",
    "latitude",
)

# Deforestation history dominates deliberately. What land has already been doing
# predicts what it does next far better than how high or steep it is; elevation
# and slope matter mainly as proxies for access, which the distance and prior-
# clearing terms already carry more directly.
FEATURE_WEIGHTS: Mapping[str, float] = {
    "forest_cover": 2.0,
    "historical_loss_rate": 4.0,
    "historical_loss_trend": 4.0,
    "prior_cleared_fraction": 2.5,
    "distance_to_road": 2.5,
    "distance_to_settlement": 2.0,
    "population_density": 1.5,
    "cropland_percentage": 2.5,
    "elevation": 1.0,
    "slope": 1.0,
    "precipitation": 1.0,
    "latitude": 1.0,
}


@dataclass(frozen=True)
class MatchingConfig:
    """How candidate controls are filtered and ranked."""

    features: tuple[str, ...] = FEATURES
    weights: Mapping[str, float] = field(default_factory=lambda: dict(FEATURE_WEIGHTS))

    # Nearest-neighbour pool size. Wide enough that the optimiser has room to
    # find a convex combination, narrow enough that it is not fitting noise from
    # land nothing like the project.
    n_neighbours: int = 250

    # Caliper on the weighted-standardised distance: 1.0 means the average
    # covariate sits a full pooled standard deviation away. A screening ceiling,
    # not a statistical rule - there is no threshold at which land stops being
    # comparable, and the number that matters is reported per control anyway.
    #
    # Set generously because it interacts badly with a small pool. Where a
    # project is genuinely unlike anything available, a tight caliper returns
    # nothing at all, and "no answer" is not more honest than "a poor answer,
    # labelled as poor" - it just moves the judgement somewhere it cannot be
    # seen. The caliper is relaxed to `min_matches` when it would bind that hard,
    # and the relaxation is recorded and propagated into confidence.
    max_distance: float = 1.5

    # Never shortlist fewer than this, however tight the caliper.
    min_matches: int = 15

    # Controls must be genuinely untreated. A parcel already substantially
    # protected is not a picture of what happens without protection.
    max_protected_fraction: float = 0.25

    # Leakage buffer. Deforestation displaced by a project lands nearby, which
    # would push control loss *up* and flatter the project. Verra's VM0048 and
    # the VCS jurisdictional methodologies use leakage belts on this order;
    # 10 km is a common floor for activity-shifting leakage, and coarser parcel
    # data needs more. Configurable because the defensible value depends on the
    # driver: smallholder frontier leakage is local, commodity-driven leakage
    # can cross a country.
    exclusion_buffer_km: float = 25.0

    # Below this the unit is too small or too cleared for a loss rate to mean
    # much: the denominator gets tiny and the ratio explodes.
    min_forest_km2: float = 50.0

    # Pre-treatment years a unit must have complete data for.
    min_pre_years: int = 5

    def with_(self, **kw) -> "MatchingConfig":
        return replace(self, **kw)


@dataclass(frozen=True)
class TrajectoryConfig:
    """Stage 9: static similarity is not enough, the history must rhyme too."""

    # Absolute ceiling on pre-treatment path disagreement, in forest-fraction
    # RMSE. A backstop for controls that are wildly different in level.
    max_rmse: float = 0.02

    # The threshold that does the real work. An absolute RMSE cutoff cannot
    # express "this control is flat and the project was not", because how far
    # apart two paths can drift depends entirely on how much the project's own
    # path moved. A project that lost 3% over its pre-period can be at most about
    # 0.03 away from a flat line, so any fixed cutoff near that value silently
    # admits the worst possible control - one that never lost anything, which
    # drags the counterfactual toward zero and flatters every project measured
    # against it.
    #
    # So the cutoff scales with the project's own pre-treatment standard
    # deviation: a control may disagree by about as much as the project itself
    # moved, and no more.
    max_rmse_ratio: float = 1.0

    # Floor under that scaling, so a project whose forest barely changed does not
    # end up with a threshold so tight that nothing can pass it.
    rmse_floor: float = 0.004

    # A control must show at least this share of the project's own pre-treatment
    # variation. States the flat-control rule directly rather than hoping an
    # RMSE threshold catches it.
    min_variation_ratio: float = 0.2

    # A control whose history moves opposite to the project's is not comparable
    # regardless of how close its levels are. Left permissive because short
    # pre-periods make correlation noisy.
    min_correlation: float = -0.5

    # Difference in average annual loss rate, in fraction per year.
    max_slope_difference: float = 0.01

    # Never filter below this many controls, however strict the thresholds. A
    # synthetic control built from three parcels is worse than one built from
    # twenty imperfect ones, and reporting low confidence beats reporting
    # nothing.
    min_controls_retained: int = 10


@dataclass(frozen=True)
class SyntheticControlConfig:
    """Stage 10: the convex programme."""

    # Relative weight on matching static covariates alongside the trajectory.
    # 0 is pure Abadie trajectory fitting. A small positive value stops the
    # optimiser picking parcels that happen to trace the same curve for
    # unrelated reasons.
    covariate_lambda: float = 0.25

    # Ridge term on the weights. Breaks ties toward spreading weight across
    # several controls rather than loading it all onto one, which both
    # stabilises the estimate and keeps any single parcel from driving the
    # verdict. Small enough not to distort the fit.
    ridge: float = 1e-4

    # Weights below this are numerical dust; zeroing them makes the reported
    # control set honest about who actually contributes.
    weight_floor: float = 1e-4

    solver_order: tuple[str, ...] = ("CLARABEL", "OSQP", "SCS", "ECOS")


@dataclass(frozen=True)
class UncertaintyConfig:
    """Stage 15: how wide is the range this estimate can honestly support."""

    n_bootstrap: int = 600
    confidence: float = 0.95
    # Fraction of the matched pool drawn in each resample.
    resample_fraction: float = 1.0
    random_seed: int = 20260821


@dataclass(frozen=True)
class RiskConfig:
    """Stage 19: how raw metrics roll up into a screening score.

    The weights below combine components that are each independently reported.
    They are a presentation choice, not a statistical result — see
    `risk_scoring.py`, which says so in its own docstring and returns every
    component separately so a reader can ignore the composite.
    """

    weight_divergence: float = 0.60
    weight_ci_separation: float = 0.40

    # Confidence discount. When the model reproduces the project's pre-treatment
    # path badly, or the controls are poor, the score is pulled toward neutral
    # rather than reported at face value.
    min_confidence_multiplier: float = 0.35

    band_thresholds: tuple[tuple[str, float], ...] = (
        ("SEVERE", 80.0),
        ("HIGH", 65.0),
        ("ELEVATED", 50.0),
        ("MODERATE", 30.0),
        ("CONSISTENT", 0.0),
    )


@dataclass(frozen=True)
class AnalysisConfig:
    """Everything the pipeline needs, assembled."""

    matching: MatchingConfig = field(default_factory=MatchingConfig)
    trajectory: TrajectoryConfig = field(default_factory=TrajectoryConfig)
    synthetic: SyntheticControlConfig = field(default_factory=SyntheticControlConfig)
    uncertainty: UncertaintyConfig = field(default_factory=UncertaintyConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)

    # Years of history used to describe a project before it starts. Longer is
    # better for identifying a synthetic control; too long and the early years
    # describe a landscape that no longer exists.
    pre_period_years: int = 8

    def with_(self, **kw) -> "AnalysisConfig":
        return replace(self, **kw)


DEFAULT_CONFIG = AnalysisConfig()
