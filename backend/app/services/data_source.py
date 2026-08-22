"""The seam between "where forest data comes from" and "what we compute with it".

Everything upstream of this interface knows about WFS endpoints, GeoTIFFs, cloud
masks and coordinate systems. Everything downstream knows about forest units and
years. The two never meet, which is what makes it possible to move from a
national monitoring product to global Hansen tiles without touching a line of the
matching or the optimiser.

A source is responsible for three things and no others:

  1. Yielding `ForestUnit` records with complete, coherent annual histories.
  2. Attaching honest provenance, including whether the data is measured,
     illustrative or synthetic.
  3. Refusing to invent values. A source that cannot measure a covariate returns
     None for it. It never returns a plausible-looking guess, because a guess
     that reaches the matcher is indistinguishable from a measurement and will
     be treated as one.
"""

from __future__ import annotations

from typing import Protocol, Sequence, runtime_checkable

from ..models.forest_cell import ForestUnit, UnitPool
from ..models.project import CarbonProject
from ..models.provenance import DataProvenance


@runtime_checkable
class ForestDataSource(Protocol):
    """What the analysis engine requires of any data provider."""

    @property
    def provenance(self) -> DataProvenance:
        """What this source is and where it came from."""

    def load_pool(self) -> UnitPool:
        """Every candidate unit the source can offer.

        Filtering for eligibility is not the source's job - `candidate_filter`
        does that, so the reasons for every exclusion are recorded in one place
        and can be reported to the user.
        """

    def load_projects(self) -> Sequence[CarbonProject]:
        """Carbon projects known to this source, with measured footprints."""

    def load_project(self, project_id: str) -> CarbonProject | None:
        """One project by id."""


class DataSourceError(RuntimeError):
    """A source could not supply what was asked of it.

    Raised rather than returning empty or placeholder data. A pipeline that
    silently analyses zero controls produces a confident-looking result built on
    nothing, which is worse than a failure.
    """


def validate_pool(pool: UnitPool, minimum: int = 20) -> None:
    """Structural checks every source's output must pass.

    Cheap, and they catch the failure mode that matters most: an adapter that
    parses successfully but wrongly, producing units that are individually
    plausible and collectively nonsense.
    """
    from .forest_service import is_physically_coherent

    if len(pool) < minimum:
        raise DataSourceError(
            f"pool holds {len(pool)} units, fewer than the {minimum} needed for a "
            f"defensible comparison. A synthetic control fitted to a handful of "
            f"parcels reports precision it does not have."
        )
    seen: set[str] = set()
    problems: list[str] = []
    for unit in pool:
        if unit.unit_id in seen:
            problems.append(f"{unit.unit_id}: duplicate id")
        seen.add(unit.unit_id)
        ok, reason = is_physically_coherent(unit)
        if not ok:
            problems.append(f"{unit.unit_id}: {reason}")
    if problems:
        head = "\n  - ".join(problems[:10])
        more = f"\n  ... and {len(problems) - 10} more" if len(problems) > 10 else ""
        raise DataSourceError(f"pool failed physical coherence:\n  - {head}{more}")


class RasterSource(Protocol):
    """The interface a raster-backed forest source will implement.

    Declared now so the shape of the eventual Hansen/GFW adapter is fixed, and
    so nothing in the engine gets written against the tabular sources by
    accident. It is deliberately not implemented: there is no raster data
    connected yet, and a stub returning fabricated cover values would be worse
    than an honest absence.

    When it is implemented it will own every raster-specific concern - nodata
    handling, cloud masking, resampling between products of different
    resolutions, and reprojection to an equal-area CRS before any hectare is
    counted - so that none of them leak into the analysis code.
    """

    def forest_cover_at(self, geometry, year: int) -> float:
        """Forested area in hectares within a geometry, for one year."""

    def annual_loss(self, geometry, first_year: int, last_year: int) -> dict[int, float]:
        """Hectares of canopy loss per year within a geometry."""
