"""Stage 6: deciding which land is even eligible to be a control.

This runs before any similarity is computed, because most of the ways a control
can be wrong have nothing to do with whether it looks similar. A protected parcel
can resemble the project on every covariate and still be useless as a
counterfactual, because protection is the treatment we are trying to price.

Every exclusion is recorded with its reason and returned. That is not
bookkeeping: the share of the pool that had to be thrown away is one of the
strongest signals about how much to trust the result, and a pipeline that
silently discards 90% of its candidates and reports a confident estimate is
lying by omission.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from ..config import MatchingConfig
from ..models.forest_cell import ForestUnit, UnitPool
from ..models.project import CarbonProject
from ..utils.geo import bbox_separation_km
from ..utils.temporal import TreatmentTiming
from . import forest_service as fs


@dataclass(frozen=True)
class Exclusion:
    unit_id: str
    reason: str
    detail: str = ""


@dataclass(frozen=True)
class CandidatePool:
    """Units eligible to be controls, and an account of everything dropped."""

    units: tuple[ForestUnit, ...]
    exclusions: tuple[Exclusion, ...]
    considered: int
    region: str = ""

    @property
    def rejected(self) -> int:
        return len(self.exclusions)

    @property
    def rejection_rate(self) -> float:
        return self.rejected / self.considered if self.considered else 0.0

    def reasons(self) -> dict[str, int]:
        return dict(Counter(e.reason for e in self.exclusions))

    def summary(self) -> dict:
        return {
            "considered": self.considered,
            "eligible": len(self.units),
            "rejected": self.rejected,
            "rejection_rate": round(self.rejection_rate, 4),
            "reasons": self.reasons(),
        }

    def __len__(self) -> int:
        return len(self.units)

    def __iter__(self):
        return iter(self.units)


class InsufficientCandidatesError(RuntimeError):
    """Not enough eligible land to build a counterfactual from.

    Raised rather than proceeding with three controls. An estimate from a pool
    that small is not a weak estimate, it is an arbitrary one, and reporting it
    with a wide confidence interval would still overstate what it knows.
    """


def build_candidate_pool(
    project: CarbonProject,
    pool: UnitPool,
    timing: TreatmentTiming,
    config: MatchingConfig,
    additional_project_units: tuple[str, ...] = (),
) -> CandidatePool:
    """Filter a pool down to genuinely untreated, comparable, observed land.

    The exclusions, in the order they are tested:

    Treated land
        The project's own footprint and the unit hosting it. Including either
        would compare the project against itself.

    Other carbon projects
        Land under another project is also treated. It is not a picture of what
        happens without a project, and if that project works, including it drags
        the counterfactual down and makes every other project look better.

    Protected areas
        Formal protection predating the analysis is a different treatment aimed
        at the same outcome. A parcel that is mostly reserve tells us what
        happens under protection, which is the wrong question.

    Leakage buffer
        Clearing displaced by a project lands nearby. A control inside that
        shadow has *more* deforestation because of the project, which inflates
        the counterfactual and flatters the project's claim. The buffer is a
        blunt instrument for a real effect; see `MatchingConfig` for why the
        default is what it is and why it must stay configurable.

    Too little forest
        Below the threshold the loss denominator gets small and the rate becomes
        unstable - a parcel with 5 km2 of forest losing 1 km2 reads as 20% loss
        and swamps parcels a thousand times its size.

    Incomplete history
        A missing year is unknown, not zero. Treating gaps as calm forest is the
        most flattering possible error in a control, so units with gaps in either
        the pre-treatment or observation window are dropped rather than patched.

    Incoherent record
        Forest that grows, or clearing that exceeds the forest available to
        clear, means the record is wrong somewhere. Better to lose the parcel
        than to average a broken one into the answer.
    """
    excluded_ids = {project.footprint.unit_id, *additional_project_units}
    if project.host_unit_id:
        excluded_ids.add(project.host_unit_id)

    keep: list[ForestUnit] = []
    dropped: list[Exclusion] = []
    observation = timing.effective_post

    for unit in pool:
        if unit.unit_id in excluded_ids:
            dropped.append(Exclusion(unit.unit_id, "treated_or_host", "project's own land"))
            continue
        if unit.is_carbon_project:
            dropped.append(Exclusion(unit.unit_id, "other_carbon_project", "under another project"))
            continue
        if unit.protected_fraction > config.max_protected_fraction:
            dropped.append(
                Exclusion(
                    unit.unit_id,
                    "protected",
                    f"{unit.protected_fraction:.0%} protected, limit "
                    f"{config.max_protected_fraction:.0%}",
                )
            )
            continue

        separation = bbox_separation_km(
            project.footprint.bbox, project.centroid, unit.bbox, unit.centroid
        )
        if separation < config.exclusion_buffer_km:
            dropped.append(
                Exclusion(
                    unit.unit_id,
                    "leakage_buffer",
                    f"{separation:.0f} km of clear land between it and the project, "
                    f"inside the {config.exclusion_buffer_km:.0f} km buffer",
                )
            )
            continue

        forest_at_start = fs.forest_km2_at(unit, timing.post_period.start)
        if forest_at_start < config.min_forest_km2:
            dropped.append(
                Exclusion(
                    unit.unit_id,
                    "too_little_forest",
                    f"{forest_at_start:.0f} km2 standing, minimum {config.min_forest_km2:.0f}",
                )
            )
            continue

        if not fs.has_complete_history(unit, timing.pre_period):
            dropped.append(Exclusion(unit.unit_id, "incomplete_pre_history", "gaps before treatment"))
            continue
        if not fs.has_complete_history(unit, observation):
            dropped.append(
                Exclusion(unit.unit_id, "incomplete_observation", "gaps in the observation window")
            )
            continue
        if timing.pre_period.length < config.min_pre_years:
            dropped.append(
                Exclusion(
                    unit.unit_id,
                    "short_pre_period",
                    f"{timing.pre_period.length} pre-treatment years, minimum "
                    f"{config.min_pre_years}",
                )
            )
            continue

        ok, reason = fs.is_physically_coherent(unit)
        if not ok:
            dropped.append(Exclusion(unit.unit_id, "incoherent_record", reason))
            continue

        keep.append(unit)

    return CandidatePool(
        units=tuple(keep),
        exclusions=tuple(dropped),
        considered=len(pool),
        region=pool.region,
    )


def require_minimum(candidates: CandidatePool, minimum: int) -> None:
    if len(candidates) < minimum:
        raise InsufficientCandidatesError(
            f"only {len(candidates)} of {candidates.considered} units are eligible as "
            f"controls, below the minimum of {minimum}. Exclusions: "
            f"{candidates.reasons()}. A counterfactual built on this pool would be "
            f"arbitrary rather than merely uncertain."
        )


def filter_candidate_controls(
    project: CarbonProject,
    pool: UnitPool,
    timing: TreatmentTiming,
    config: MatchingConfig,
    minimum: int = 10,
    additional_project_units: tuple[str, ...] = (),
) -> CandidatePool:
    """Build the pool and refuse to continue if it is too thin."""
    candidates = build_candidate_pool(project, pool, timing, config, additional_project_units)
    require_minimum(candidates, minimum)
    return candidates
