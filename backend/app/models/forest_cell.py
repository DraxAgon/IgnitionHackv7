"""The unit of analysis: one parcel of land with a forest history.

Deliberately not called a "cell". The engine works on whatever spatial unit the
data source yields - 1 km raster cells built from Hansen tiles, 1-degree parcels
aggregated from a national monitoring programme, or a project's own surveyed
footprint. Nothing downstream of the adapter is allowed to care which, so that
swapping the data provider does not touch the mathematics.

A unit stores *increments*: how much forest was cleared in each year. Standing
forest at any year is derived from them. That direction matters - clearing is
what satellites actually detect, and deriving stock from flux keeps the series
internally consistent instead of letting two independently measured numbers
drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping

from .provenance import DataProvenance


@dataclass(frozen=True)
class ForestUnit:
    """One comparable parcel of forest.

    Attributes
    ----------
    unit_id
        Stable identifier, unique within a pool.
    centroid
        (longitude, latitude) in EPSG:4326. Used for the leakage buffer and for
        putting controls on a map - never for area arithmetic, which happens in
        a projected CRS (see `utils.geo`).
    land_km2
        Land surface of the unit, water excluded.
    forest_baseline_km2
        Forest standing at the start of `first_year`. Every loss fraction is
        taken against a denominator derived from this.
    cleared_km2_by_year
        Forest cleared *during* each year. A missing year means unobserved, not
        zero clearing, and `forest_service.has_complete_history` enforces the
        difference before a unit is allowed to be a control.
    covariates
        Pre-treatment descriptors, keyed by the names in `config.FEATURES`.
        A value of None means "not measured here", which is different from zero
        and is handled as such by the matcher.
    protected_fraction
        Share of the unit under formal protection predating the analysis. High
        values disqualify a unit as a control: protected land is not a picture
        of what happens without protection.
    is_carbon_project
        Whether a carbon project overlaps this unit. Such units are excluded
        from control pools - they are treated, not untreated.
    """

    unit_id: str
    centroid: tuple[float, float]
    land_km2: float
    forest_baseline_km2: float
    first_year: int
    cleared_km2_by_year: Mapping[int, float]
    provenance: DataProvenance
    covariates: Mapping[str, float | None] = field(default_factory=dict)
    bbox: tuple[float, float, float, float] | None = None
    label: str = ""
    country: str = ""
    ecoregion: str = ""
    forest_type: str = ""
    protected_fraction: float = 0.0
    is_carbon_project: bool = False
    prior_cleared_km2: float = 0.0

    def __post_init__(self) -> None:
        if self.land_km2 <= 0:
            raise ValueError(f"{self.unit_id}: land area must be positive, got {self.land_km2}")
        if self.forest_baseline_km2 < 0:
            raise ValueError(f"{self.unit_id}: negative forest baseline")
        # A tolerance rather than hard equality: forest and land come from
        # different layers and round independently.
        if self.forest_baseline_km2 > self.land_km2 * 1.01 + 1.0:
            raise ValueError(
                f"{self.unit_id}: forest {self.forest_baseline_km2} km2 exceeds "
                f"land {self.land_km2} km2"
            )
        if not 0.0 <= self.protected_fraction <= 1.0:
            raise ValueError(f"{self.unit_id}: protected fraction outside [0, 1]")

    @property
    def observed_years(self) -> tuple[int, ...]:
        return tuple(sorted(self.cleared_km2_by_year))

    @property
    def last_year(self) -> int:
        return max(self.cleared_km2_by_year) if self.cleared_km2_by_year else self.first_year

    @property
    def longitude(self) -> float:
        return self.centroid[0]

    @property
    def latitude(self) -> float:
        return self.centroid[1]

    def covariate(self, name: str) -> float | None:
        return self.covariates.get(name)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ForestUnit({self.unit_id}, {self.forest_baseline_km2:.0f} km2 forest)"


@dataclass(frozen=True)
class UnitPool:
    """A set of candidate units and the provenance they share."""

    units: tuple[ForestUnit, ...]
    provenance: DataProvenance
    region: str = ""
    resolution_note: str = ""

    def __len__(self) -> int:
        return len(self.units)

    def __iter__(self):
        return iter(self.units)

    def by_id(self, unit_id: str) -> ForestUnit | None:
        return next((u for u in self.units if u.unit_id == unit_id), None)

    def excluding(self, *unit_ids: str) -> "UnitPool":
        drop = set(unit_ids)
        return UnitPool(
            units=tuple(u for u in self.units if u.unit_id not in drop),
            provenance=self.provenance,
            region=self.region,
            resolution_note=self.resolution_note,
        )
