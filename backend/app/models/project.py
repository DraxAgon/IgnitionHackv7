"""A carbon project: a boundary, a start date, and a claim.

The claim is the thing under examination. It is kept in its own object with its
own provenance because it is categorically different from the measurements
around it - a projection written by the party that benefits from it, which may
be entirely reasonable or entirely wrong, and which this engine exists to
compare against independent evidence rather than to accept or to reject.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from .forest_cell import ForestUnit
from .provenance import DataProvenance, Provenance


@dataclass(frozen=True)
class ProjectClaim:
    """What the project told the registry would happen without it.

    `baseline_loss` is the fraction of the project's forest predicted to be
    cleared over the crediting window in the absence of the project. It is a
    fraction of initial forest area, not of total project area - the two differ
    whenever a project contains non-forest land, and confusing them silently
    inflates or deflates every comparison downstream.
    """

    baseline_loss: float
    credits_issued: int = 0
    credits_retired: int = 0
    price_per_credit: float | None = None
    methodology: str = ""
    registry: str = ""
    registry_reference: str = ""
    baseline_path: tuple[float, ...] | None = None
    provenance: DataProvenance = field(
        default_factory=lambda: DataProvenance(
            kind=Provenance.ILLUSTRATIVE, source="unspecified"
        )
    )

    def __post_init__(self) -> None:
        if not 0.0 < self.baseline_loss < 1.0:
            raise ValueError(
                f"claimed baseline loss must be a fraction strictly inside (0, 1), "
                f"got {self.baseline_loss}. A baseline of 0 claims nothing and a "
                f"baseline of 1 claims total clearance."
            )
        if self.credits_retired > self.credits_issued:
            raise ValueError("retired credits exceed issued credits")
        if self.baseline_path is not None:
            path = self.baseline_path
            if any(b < a - 1e-9 for a, b in zip(path, path[1:])):
                raise ValueError("claimed baseline path decreases; cumulative loss cannot fall")


@dataclass(frozen=True)
class CarbonProject:
    """A project and the forest it covers.

    `footprint` is the treated unit: forest history measured on the project's own
    boundary. That is what the synthetic control is fitted to, because it is what
    the project actually is. `host_unit_id` names the pool unit the project sits
    inside, used only to exclude that unit and its neighbours from the control
    pool - never as a source of outcome data.
    """

    project_id: str
    name: str
    start_year: int
    footprint: ForestUnit
    claim: ProjectClaim
    crediting_years: int = 10
    short_name: str = ""
    country: str = ""
    locality: str = ""
    geometry: Mapping[str, Any] | None = None
    host_unit_id: str | None = None
    area_ha: float | None = None

    def __post_init__(self) -> None:
        if self.footprint.first_year > self.start_year:
            raise ValueError(
                f"{self.project_id}: forest history begins in {self.footprint.first_year}, "
                f"after the project starts in {self.start_year}. There is no pre-treatment "
                f"period to match on."
            )
        if self.crediting_years <= 0:
            raise ValueError(f"{self.project_id}: crediting period must be positive")

    @property
    def centroid(self) -> tuple[float, float]:
        return self.footprint.centroid

    @property
    def display_name(self) -> str:
        return self.short_name or self.name

    @property
    def crediting_end_year(self) -> int:
        return self.start_year + self.crediting_years - 1

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"CarbonProject({self.project_id}, {self.display_name}, start {self.start_year})"
