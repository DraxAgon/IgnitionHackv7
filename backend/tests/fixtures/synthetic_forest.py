"""Synthetic forest fixtures with a known answer.

CLEARLY MARKED SYNTHETIC. Nothing generated here describes any real forest,
project or place. Every unit produced carries `Provenance.SYNTHETIC`, and
`ResultProvenance.caveat` turns that into a visible warning on any result
computed from it. These fixtures exist to test the mathematics and must never be
used to produce a statement about a carbon project.

Why generate data at all when real PRODES measurements are available. Real data
cannot test whether the estimator is *correct*, only whether it runs, because the
true counterfactual for a real project is unobservable - that is the entire
problem this engine exists to work around. Here the true counterfactual is
constructed, so the estimator can be scored against it.

The construction:

  1. Build a pool of control units whose annual clearing is driven by a shared
     regional shock plus a unit-specific rate plus noise. The shared component
     matters: without it the units would be independent and a synthetic control
     would have nothing real to latch onto, making the test easier than reality.

  2. Build a treated unit as an exact convex combination of a few controls, so a
     perfect synthetic control provably exists. If the optimiser cannot find a
     good fit when one is guaranteed, the optimiser is broken.

  3. Carry that same combination forward past the pseudo-start year to get the
     TRUE counterfactual, then apply a known treatment effect to produce what
     the treated unit "actually" did.

The test then asks whether the pipeline recovers the true counterfactual and the
true treatment effect using only pre-treatment information. It cannot see the
weights, and step 3's counterfactual is never written into the treated unit's
record.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.models.forest_cell import ForestUnit, UnitPool
from app.models.project import CarbonProject, ProjectClaim
from app.models.provenance import DataProvenance, Provenance

SYNTHETIC = DataProvenance(
    kind=Provenance.SYNTHETIC,
    source="tests/fixtures/synthetic_forest.py",
    note=(
        "Generated test data with a constructed ground truth. Describes no real forest. "
        "Any result computed from it is a test of the algorithm, not a finding."
    ),
)

FIRST_YEAR = 2000
LAST_YEAR = 2020
START_YEAR = 2011


@dataclass(frozen=True)
class SyntheticScenario:
    """A generated world, plus the answers the estimator is supposed to find."""

    pool: UnitPool
    project: CarbonProject
    donor_ids: tuple[str, ...]
    true_weights: np.ndarray
    true_counterfactual_loss: float
    true_actual_loss: float
    true_avoided: float
    start_year: int
    last_year: int

    @property
    def true_supported_fraction(self) -> float:
        claimed_avoided = max(0.0, self.project.claim.baseline_loss - self.true_actual_loss)
        if claimed_avoided <= 0:
            return float("nan")
        return min(1.0, self.true_avoided / claimed_avoided)


def _make_unit(
    unit_id: str,
    lon: float,
    lat: float,
    land_km2: float,
    forest_km2: float,
    cleared: dict[int, float],
    covariates: dict[str, float | None],
    protected: float = 0.0,
) -> ForestUnit:
    return ForestUnit(
        unit_id=unit_id,
        centroid=(lon, lat),
        bbox=(lon - 0.5, lat - 0.5, lon + 0.5, lat + 0.5),
        land_km2=land_km2,
        forest_baseline_km2=forest_km2,
        first_year=FIRST_YEAR,
        cleared_km2_by_year=cleared,
        covariates=covariates,
        label=f"synthetic {unit_id}",
        country="Synthetica",
        ecoregion="test",
        forest_type="test",
        protected_fraction=protected,
        provenance=SYNTHETIC,
    )


def build_scenario(
    seed: int = 7,
    n_controls: int = 60,
    treatment_effect: float = 0.6,
    claimed_baseline: float = 0.30,
    noise: float = 0.00035,
) -> SyntheticScenario:
    """Generate a pool, a treated unit, and the ground truth for both.

    `treatment_effect` is the share of clearing the pretend project prevents:
    0.6 means the treated unit clears at 40% of its counterfactual rate after the
    start year. `claimed_baseline` is deliberately set well above what the
    generated world produces, so the fixture exercises the over-crediting path -
    the test asserts the pipeline recovers the constructed truth, not that it
    reaches any particular verdict.

    `noise` is small but non-zero. With zero noise the recovery problem is
    trivially exact and the test would pass even for an estimator with no
    tolerance for real data.
    """
    rng = np.random.default_rng(seed)
    years = list(range(FIRST_YEAR, LAST_YEAR + 1))

    # A shared regional signal - commodity prices, enforcement cycles, weather.
    # Every unit responds to it with its own sensitivity, which is what makes a
    # weighted combination of controls able to track a treated unit at all.
    regional = rng.normal(1.0, 0.25, size=len(years)).cumsum() / np.arange(1, len(years) + 1)
    regional = np.clip(regional, 0.4, 1.8)

    controls: list[ForestUnit] = []
    rates = rng.uniform(0.0015, 0.012, size=n_controls)
    sensitivity = rng.uniform(0.5, 1.5, size=n_controls)

    for i in range(n_controls):
        land = float(rng.uniform(800, 1500))
        forest = land * float(rng.uniform(0.80, 0.98))
        standing = forest
        cleared: dict[int, float] = {}
        for j, year in enumerate(years):
            rate = rates[i] * (1.0 + sensitivity[i] * (regional[j] - 1.0))
            rate = max(0.0, rate + rng.normal(0.0, noise))
            amount = min(standing, standing * rate)
            cleared[year] = round(float(amount), 4)
            standing -= amount
        controls.append(
            _make_unit(
                unit_id=f"S{i:03d}",
                # Spread widely so the leakage buffer does not eliminate the pool.
                lon=-60.0 + (i % 10) * 3.0,
                lat=-10.0 + (i // 10) * 3.0,
                land_km2=land,
                forest_km2=forest,
                cleared=cleared,
                covariates={
                    # Correlated with the clearing rate, as real covariates are:
                    # accessible, low-lying, populated land clears faster.
                    "elevation": float(600 - 20000 * rates[i] + rng.normal(0, 25)),
                    "slope": float(12 - 400 * rates[i] + rng.normal(0, 1.5)),
                    "distance_to_road": float(40 - 2200 * rates[i] + rng.normal(0, 3)),
                    "distance_to_settlement": float(60 - 3000 * rates[i] + rng.normal(0, 5)),
                    "population_density": float(4 + 900 * rates[i] + rng.normal(0, 1.2)),
                    "cropland_percentage": float(np.clip(20 * rates[i] + rng.normal(0, 0.01), 0, 1)),
                    "precipitation": float(2000 + rng.normal(0, 120)),
                    "latitude": -10.0 + (i // 10) * 3.0,
                },
            )
        )

    # The treated unit: an exact convex combination of three donors, so a
    # perfect pre-treatment fit is known to exist.
    donor_idx = [3, 17, 41]
    true_weights = np.array([0.5, 0.3, 0.2])
    donors = [controls[i] for i in donor_idx]

    land = float(np.dot(true_weights, [d.land_km2 for d in donors]))
    forest = float(np.dot(true_weights, [d.forest_baseline_km2 for d in donors]))

    # Per-year clearing as a fraction of each donor's own standing forest, so the
    # combination is over *rates* rather than absolute areas. Combining absolute
    # areas would make the treated unit's history depend on donor sizes, which is
    # not what a synthetic control models.
    donor_rate_paths: list[list[float]] = []
    for d in donors:
        standing = d.forest_baseline_km2
        path = []
        for year in years:
            amount = d.cleared_km2_by_year[year]
            path.append(amount / standing if standing > 0 else 0.0)
            standing -= amount
        donor_rate_paths.append(path)
    blended_rate = np.average(np.array(donor_rate_paths), axis=0, weights=true_weights)

    treated_cleared: dict[int, float] = {}
    standing = forest
    cf_standing = forest
    counterfactual_cleared: dict[int, float] = {}
    for j, year in enumerate(years):
        rate = float(blended_rate[j])
        # Counterfactual: what the unit would have done untreated, throughout.
        cf_amount = min(cf_standing, cf_standing * rate)
        counterfactual_cleared[year] = cf_amount
        cf_standing -= cf_amount
        # Observed: identical before the start year, suppressed afterwards.
        effective = rate * (1.0 - treatment_effect) if year >= START_YEAR else rate
        amount = min(standing, standing * effective)
        treated_cleared[year] = round(float(amount), 4)
        standing -= amount

    treated = _make_unit(
        unit_id="TREATED",
        lon=-45.0,
        lat=-4.0,
        land_km2=land,
        forest_km2=forest,
        cleared=treated_cleared,
        covariates={
            key: float(np.dot(true_weights, [d.covariates[key] for d in donors]))
            for key in donors[0].covariates
        },
    )

    # Ground truth, computed on the same convention the engine uses: loss over
    # the observation window as a share of forest standing when it opened.
    def _standing_at(cleared_map: dict[int, float], year: int) -> float:
        s = forest
        for y in range(FIRST_YEAR, year):
            s -= cleared_map.get(y, 0.0)
        return max(0.0, s)

    cf_base = _standing_at(counterfactual_cleared, START_YEAR)
    cf_lost = sum(counterfactual_cleared[y] for y in range(START_YEAR, LAST_YEAR + 1))
    true_cf_loss = cf_lost / cf_base

    actual_base = _standing_at(treated_cleared, START_YEAR)
    actual_lost = sum(treated_cleared[y] for y in range(START_YEAR, LAST_YEAR + 1))
    true_actual_loss = actual_lost / actual_base

    project = CarbonProject(
        project_id="SYN-001",
        name="Synthetic Test Project",
        short_name="Synthetic",
        start_year=START_YEAR,
        crediting_years=LAST_YEAR - START_YEAR + 1,
        footprint=treated,
        host_unit_id=None,
        country="Synthetica",
        claim=ProjectClaim(
            baseline_loss=claimed_baseline,
            credits_issued=1_000_000,
            credits_retired=250_000,
            price_per_credit=5.0,
            methodology="synthetic fixture",
            registry="none",
            provenance=SYNTHETIC,
        ),
    )

    return SyntheticScenario(
        pool=UnitPool(
            units=tuple(controls),
            provenance=SYNTHETIC,
            region="Synthetica",
            resolution_note="generated fixture, 1-degree equivalent",
        ),
        project=project,
        donor_ids=tuple(controls[i].unit_id for i in donor_idx),
        true_weights=true_weights,
        true_counterfactual_loss=true_cf_loss,
        true_actual_loss=true_actual_loss,
        true_avoided=max(0.0, true_cf_loss - true_actual_loss),
        start_year=START_YEAR,
        last_year=LAST_YEAR,
    )


def write_csv(scenario: SyntheticScenario, path: Path) -> Path:
    """Dump the scenario to `synthetic_forest_data.csv`, one row per unit-year.

    A readable artefact for inspecting the fixture by hand, and the file the
    project brief asked for by name. The generator above remains the source of
    truth - the CSV is written from it, never read back into the tests, so the
    two cannot drift apart.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            [
                "PROVENANCE: SYNTHETIC TEST FIXTURE - describes no real forest or project",
            ]
        )
        writer.writerow(
            ["unit_id", "role", "year", "cleared_km2", "land_km2", "forest_baseline_km2", "lon", "lat"]
        )
        units = [(scenario.project.footprint, "treated")] + [(u, "control") for u in scenario.pool.units]
        for unit, role in units:
            for year in sorted(unit.cleared_km2_by_year):
                writer.writerow(
                    [
                        unit.unit_id,
                        role,
                        year,
                        f"{unit.cleared_km2_by_year[year]:.4f}",
                        f"{unit.land_km2:.2f}",
                        f"{unit.forest_baseline_km2:.2f}",
                        f"{unit.centroid[0]:.3f}",
                        f"{unit.centroid[1]:.3f}",
                    ]
                )
    return path


if __name__ == "__main__":  # pragma: no cover
    scenario = build_scenario()
    out = write_csv(scenario, Path(__file__).parent / "synthetic_forest_data.csv")
    print(f"wrote {out}")
    print(f"true counterfactual loss : {scenario.true_counterfactual_loss:.4%}")
    print(f"true actual loss         : {scenario.true_actual_loss:.4%}")
    print(f"true avoided             : {scenario.true_avoided:.4%}")
