"""Describing a parcel by what was knowable before the project began.

Two kinds of covariate end up in the same vector:

  Derived      Computed here from the forest history - how much forest, how fast
               it was going, whether that was speeding up. These are the ones
               that carry real predictive weight, and the ones where a temporal
               leak is easiest to introduce and hardest to spot.

  Supplied     Handed over by the data adapter - elevation, slope, distance to
               road, population. Static or slow-moving, so a single value stands
               for the pre-treatment period.

Every derived covariate is computed against the *flux* window that ends the year
before treatment. That window comes from `TreatmentTiming`, never from a literal,
so moving the cutoff for a backtest moves every covariate with it and there is no
second place to forget to update.

Adding a covariate means writing one function and decorating it. Nothing else in
the engine needs to change: matching, balance diagnostics and the optimiser all
read the registry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Mapping, Sequence

from ..models.forest_cell import ForestUnit
from ..models.project import CarbonProject
from ..utils.stats import safe_divide
from ..utils.temporal import PreTreatmentView, TreatmentTiming, Window
from . import forest_service as fs


@dataclass(frozen=True)
class FeatureSpec:
    """One covariate: how to compute it, and why it is in the model at all.

    `why` is not documentation for its own sake. A matched-control analysis is
    only as defensible as its covariate set, and anyone auditing this needs to
    see the argument for each one without reading the implementation.
    """

    name: str
    label: str
    unit: str
    why: str
    compute: Callable[[ForestUnit, TreatmentTiming], float | None]
    derived_from_history: bool = False


_REGISTRY: dict[str, FeatureSpec] = {}


def feature(name: str, label: str, unit: str, why: str, derived_from_history: bool = False):
    """Register a covariate."""

    def wrap(fn: Callable[[ForestUnit, TreatmentTiming], float | None]) -> Callable:
        _REGISTRY[name] = FeatureSpec(
            name=name,
            label=label,
            unit=unit,
            why=why,
            compute=fn,
            derived_from_history=derived_from_history,
        )
        return fn

    return wrap


def registry() -> Mapping[str, FeatureSpec]:
    return dict(_REGISTRY)


def describe_features(names: Sequence[str]) -> list[dict]:
    """Feature metadata for the API, so the interface can explain a match."""
    return [
        {
            "name": s.name,
            "label": s.label,
            "unit": s.unit,
            "why": s.why,
            "derived_from_history": s.derived_from_history,
        }
        for n in names
        if (s := _REGISTRY.get(n)) is not None
    ]


# ---- derived from pre-treatment forest history ----------------------------

@feature(
    "forest_cover",
    "Forest share of land",
    "fraction",
    "How much of the parcel was still forest when the reference period opened. "
    "Land that is already mostly cleared cannot lose much more, so this bounds "
    "any plausible baseline.",
    derived_from_history=True,
)
def _forest_cover(unit: ForestUnit, timing: TreatmentTiming) -> float | None:
    return safe_divide(
        fs.forest_km2_at(unit, timing.pre_period.start), unit.land_km2, default=None
    )


@feature(
    "historical_loss_rate",
    "Prior clearing rate",
    "fraction/year",
    "Deforestation pressure already on the parcel before the crediting window. "
    "The single strongest predictor of what happens next, which is why it carries "
    "the heaviest matching weight.",
    derived_from_history=True,
)
def _historical_loss_rate(unit: ForestUnit, timing: TreatmentTiming) -> float | None:
    return fs.historical_loss_rate(unit, timing.pre_period)


@feature(
    "historical_loss_trend",
    "Clearing trend",
    "fraction/year/year",
    "Whether that pressure was building or easing. Two parcels with the same "
    "average clearing behave very differently going forward if one was winding "
    "down and the other accelerating.",
    derived_from_history=True,
)
def _historical_loss_trend(unit: ForestUnit, timing: TreatmentTiming) -> float | None:
    return fs.historical_loss_trend(unit, timing.pre_period)


@feature(
    "prior_cleared_fraction",
    "Historic clearing",
    "fraction",
    "Share already cleared before the record begins. A proxy for roads, "
    "settlement and access: the frontier reaches previously cleared land first.",
    derived_from_history=True,
)
def _prior_cleared_fraction(unit: ForestUnit, timing: TreatmentTiming) -> float | None:
    if unit.prior_cleared_km2 <= 0 and "prior_cleared_fraction" not in unit.covariates:
        return None
    supplied = unit.covariate("prior_cleared_fraction")
    if supplied is not None:
        return supplied
    return safe_divide(unit.prior_cleared_km2, unit.land_km2, default=None)


# ---- supplied by the adapter ----------------------------------------------
# These read straight from the unit's covariate mapping. They are declared here
# rather than pulled implicitly so that the model's covariate set is a single
# readable list, and so each one carries its justification.

def _passthrough(name: str, label: str, unit_str: str, why: str) -> None:
    @feature(name, label, unit_str, why)
    def _fn(unit: ForestUnit, timing: TreatmentTiming, _name: str = name) -> float | None:
        return unit.covariate(_name)


_passthrough(
    "elevation", "Elevation", "m",
    "Terrain shapes both agricultural suitability and how reachable a parcel is.",
)
_passthrough(
    "slope", "Slope", "degrees",
    "Broken or steep ground resists mechanised clearing, so it changes the "
    "economics of conversion independently of how remote the land is.",
)
_passthrough(
    "distance_to_road", "Distance to road", "km",
    "Access is the dominant driver of frontier deforestation. Roads existing "
    "before the project only - a road built afterwards is an outcome, not a "
    "pre-treatment characteristic.",
)
_passthrough(
    "distance_to_settlement", "Distance to settlement", "km",
    "Proximity to people who clear land, complementary to road access.",
)
_passthrough(
    "population_density", "Population density", "people/km2",
    "Local demand for land, measured before the project period.",
)
_passthrough(
    "cropland_percentage", "Cropland share", "fraction",
    "Agricultural pressure already realised nearby, a direct measure of the "
    "conversion economics facing the remaining forest.",
)
_passthrough(
    "precipitation", "Rainfall", "mm/year",
    "Separates wet closed-canopy forest from drier transitional forest, which "
    "clear under different economics and burn under different conditions.",
)
_passthrough(
    "latitude", "Latitude", "degrees",
    "Stands in for the broad gradient in biome and settlement history that the "
    "other covariates do not capture directly.",
)


# ---- extraction -----------------------------------------------------------

def extract_cell_features(
    unit: ForestUnit, timing: TreatmentTiming, features: Sequence[str]
) -> dict[str, float | None]:
    """The pre-treatment covariate vector for one candidate control.

    Missing values stay None rather than being imputed. An unmeasured slope is
    not a flat one, and filling it in with a pool average would manufacture
    similarity the data does not support - the matcher skips absent covariates
    instead, and reports how many it used.
    """
    out: dict[str, float | None] = {}
    for name in features:
        spec = _REGISTRY.get(name)
        if spec is None:
            out[name] = None
            continue
        try:
            value = spec.compute(unit, timing)
        except (KeyError, ZeroDivisionError):
            value = None
        out[name] = None if value is None else float(value)
    # Latitude is intrinsic to the unit and always available, so it is filled
    # from the centroid when no adapter supplied it.
    if "latitude" in out and out["latitude"] is None:
        out["latitude"] = float(unit.latitude)
    return out


def extract_project_features(
    project: CarbonProject, timing: TreatmentTiming, features: Sequence[str]
) -> dict[str, float | None]:
    """Stage 5: the project's own fingerprint, measured on its own footprint.

    Identical code path to the controls, deliberately. If the treated unit were
    described by a different procedure than the units it is compared against,
    any difference between them would be partly an artefact of the procedure.
    """
    return extract_cell_features(project.footprint, timing, features)


def extract_pre_trajectory(unit: ForestUnit, timing: TreatmentTiming) -> PreTreatmentView:
    """The whole pre-treatment forest path, not a summary of it.

    Averages throw away the shape, and the shape is what identifies a good
    control. Two parcels can share a mean clearing rate while one lost forest
    steadily and the other in a single burst - they are not the same kind of
    land and will not behave the same way next.

    Returned as a `PreTreatmentView`, which raises if anything downstream asks it
    for a year at or after the project starts. The window runs to the start year
    inclusive because that value is a *stock* - forest standing on the first day
    of the project, determined entirely by earlier clearing - and it is the level
    every post-treatment loss is measured against.
    """
    window = timing.pre_stock_window
    series = fs.remaining_fraction_series(unit, window, anchor_year=window.start)
    return PreTreatmentView(series, window, label=f"{unit.unit_id} pre-treatment forest")


def covariate_table(
    units: Sequence[ForestUnit], timing: TreatmentTiming, features: Sequence[str]
) -> list[dict[str, float | None]]:
    return [extract_cell_features(u, timing, features) for u in units]


def default_timing(
    start_year: int,
    pre_years: int,
    last_observed_year: int,
    cutoff_year: int | None = None,
    earliest_data_year: int | None = None,
) -> TreatmentTiming:
    """Build the timing for a project from its start year and the data on hand.

    Clamps the requested pre-period to what the record actually covers, so a
    project starting two years after the dataset begins gets a short pre-period
    and an honest warning downstream, rather than a window silently padded with
    years that were never observed.
    """
    pre_start = start_year - pre_years
    if earliest_data_year is not None:
        pre_start = max(pre_start, earliest_data_year)
    return TreatmentTiming(
        start_year=start_year,
        pre_period=Window(pre_start, start_year - 1),
        post_period=Window(start_year, last_observed_year),
        cutoff_year=cutoff_year,
    )
