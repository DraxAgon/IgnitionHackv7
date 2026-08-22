# Phantom analysis engine

Independent reconstruction of a forest carbon project's deforestation baseline, using matched
controls and synthetic control methods over observed satellite forest-loss records.

The engine answers one question: **did comparable untreated forest actually behave the way this
project's baseline said it would?** It produces a counterfactual estimate with an interval, compares
it against the submitted baseline, and reports how much of the claimed avoided deforestation that
estimate can account for. It does not, and structurally cannot, produce a finding of wrongdoing.

```bash
python -m venv .venv && .venv/Scripts/pip install -r backend/requirements.txt
cd backend && python -m pytest -q          # 102 tests, ~50s
```

## What is real here

| | |
|---|---|
| **Forest loss** | INPE PRODES via TerraBrasilis WFS — 277 one-degree parcels of the Brazilian Legal Amazon, annual clear-cut increments 2008–2023. Collected by `tools/collect.mjs` in the repository root. Measured, not modelled. |
| **Terrain, rainfall** | Open-Meteo elevation and archive APIs. Rainfall is partially missing and stays `None` where unmeasured — the matcher skips it rather than treating a parcel as a desert. |
| **Project footprints** | Real: PRODES queried against each project's own boundary. |
| **Claimed baselines, credit volumes, registry status** | **Illustrative.** They describe no real project and name no real party. |

Every result carries a `ResultProvenance`. When either side of the comparison is illustrative or
synthetic, `is_finding` is `False` and a caveat travels with the numbers into the API response.
`tests/test_language_guard.py` fails the build if that stops being true.

## Layout

```
app/
  config.py                    every tunable, with the reasoning for each default
  models/
    provenance.py              measured / reported / illustrative / synthetic / modelled
    forest_cell.py             ForestUnit — the unit of analysis, whatever its resolution
    project.py                 CarbonProject + ProjectClaim (kept separate on purpose)
    analysis_result.py         result container + the API response shape
  services/
    data_source.py             the adapter seam: sources yield units, nothing more
    sources/prodes_cells.py    INPE PRODES adapter (real measurements)
    forest_service.py          stock/flux arithmetic — loss fractions, trajectories
    feature_engineering.py     covariate registry; add one by decorating a function
    candidate_filter.py        eligibility, with every exclusion reason recorded
    control_matching.py        standardise, weight, rank; per-covariate explanations
    trajectory.py              pre-treatment path similarity and filtering
    synthetic_control.py       the cvxpy programme; returns locked, immutable weights
    counterfactual.py          counterfactual loss, avoided loss, supported fraction
    uncertainty.py             bootstrap intervals
    model_quality.py           fit, composition, balance, confidence label
    placebo_testing.py         accuracy measured on land where the answer is known
    risk_scoring.py            transparent components; the composite is a UI layer
    pipeline.py                run_project_analysis — the orchestrator
  utils/
    temporal.py                the temporal firewall
    normalization.py           scaling, weighted distance, balance diagnostics
    geo.py                     CRS-correct area and distance; never degrees as length
    stats.py                   shared primitives
notebooks/
  prototype_analysis.ipynb        every stage on a fixture with a known answer
  prodes_amazon_analysis.ipynb    the same pipeline on real PRODES measurements
tests/
  fixtures/synthetic_forest.py    generator with constructed ground truth
```

Data-source code and modelling code never mix. `control_matching.py` cannot tell whether its forest
histories came from PRODES, Hansen tiles or a CSV, which is what makes the provider swappable.

## The temporal firewall

Control selection must never see post-treatment data. That is easy to state and easy to violate by
adding a covariate six months later, so it is enforced structurally rather than by discipline:

- Matching, trajectory filtering and weight optimisation receive `PreTreatmentView` objects, which
  raise `TemporalLeakError` if asked for a year at or after the project start. The post-treatment
  series is not passed to them at all.
- Weights are frozen into an immutable `SyntheticControlFit` with read-only arrays before any
  post-treatment data is read. `apply_locked_weights` takes a finished fit and cannot alter it.
- `test_post_treatment_data_cannot_change_the_estimate` multiplies all post-cutoff clearing by 2.5
  and asserts the estimate does not move by more than 1e-12. Any leak — however indirect — fails it.
  A mirror test confirms that corrupting data *inside* the window does move the answer, so the
  guarantee cannot be satisfied by a pipeline that ignores its inputs.

One subtlety the code is explicit about: clearing is a **flux** recorded against a year, standing
forest is a **stock** measured at an instant. Forest standing on the project's first day is fixed by
earlier clearing, so it is pre-treatment information and is the anchor every later loss is measured
against. Flux windows stop at `start_year - 1`; stock windows run to `start_year`.

## Two bugs this design caught

Both are recorded because they show what the tests are for.

**The counterfactual was short by a year.** Observed project loss counted clearing in 2016–2023
while the counterfactual measured stock from the start of 2016 to the start of 2023 — one fewer year
of loss. Pre-treatment fit was excellent and every component behaved correctly, so nothing noticed
until the estimate was scored against a constructed truth. It biased every project toward looking
over-credited, by about one year in N.

| | before | after |
|---|---|---|
| bias | −0.0069 | **−0.00057** |
| MAE | 0.0069 | **0.00060** |
| interval coverage | 0% | **86%** |

**A flat control passed the trajectory filter.** Against a project that lost 3% of its forest over
the pre-period, a control that lost nothing sits only 0.019 away in RMSE — under the 0.02 absolute
threshold. A fixed cutoff cannot catch this case, because a flat line can only ever be about as far
from a project as the project moved. The threshold now scales with the project's own pre-treatment
variation, and a control must show at least a fifth of it. Flat controls are the most dangerous kind:
they drag the counterfactual toward zero and flatter every project measured against them.

## What the engine actually achieves

On the synthetic fixture, where the truth is constructed and hidden, the estimator recovers the
counterfactual to within a fraction of a percentage point with near-zero bias.

On **real PRODES parcels** the same placebo procedure — 60 untreated parcels, pretend 2016 start,
predicted from data ending 2015, scored against what the satellite recorded — gives:

```
n                     60      median error          +0.0001
MAE                0.0424    bias                  -0.0188
RMSE               0.1033    interval coverage       0.617
p90 abs error      0.1079    (nominal 0.95)
```

The median error is near zero; the mean absolute error is about **4 percentage points of forest
cover**, RMSE far exceeds MAE (a heavy tail), and the intervals are materially too narrow.

Three things follow, and they bound what this engine may be used for today:

1. **A 4-point error is the same order as the discrepancies being reported.** At this resolution the
   engine supports screening — *this baseline deserves a closer look* — and not adjudication. Its own
   confidence labels already read LOW for most of the shipped projects.
2. **The intervals need placebo calibration.** The bootstrap resamples donors, so it sees only
   sensitivity to which parcels were available. Weight non-uniqueness and model misspecification are
   real and invisible to it. `uncertainty.describe()` says the interval is a lower bound on total
   uncertainty; the fix is to widen it against the measured placebo error distribution.
3. **The likeliest cause is resolution, not method.** One-degree parcels average over enormous
   internal variation; 72 units are eligible and effective control counts run 2–3. Finer units from
   Hansen/GFW tiles are the next substantive improvement, ahead of any modelling change.

The synthetic-control weights are also badly underdetermined on a short pre-period: many quite
different weightings fit the pre-period to within 1e-4 and then diverge. This is measured, not
assumed — `test_the_trajectory_objective_is_underdetermined_on_a_short_pre_period`. It is why
effective control count and weight concentration are reported next to RMSE rather than behind it, and
why a near-perfect pre-treatment fit is treated as weak evidence that the right donors were found.

## Two project footprints are refused

`Tucumã` and `Castanheira` have prior clearing recorded as larger than their own land area — the
bounding-box straddling artefact the root `README.md` documents — so their forest baseline computes
to zero. Every loss ratio then divides by zero and returns 0.0%, which reads as a pristine,
perfectly protected forest rather than a broken denominator.

That is the most dangerous direction for an error to point in this tool, so `_validate_treated_unit`
refuses those projects with an explanation instead of reporting them. Note that the JavaScript app
currently shows `0.0%` observed loss for Castanheira, and the root README quotes that figure — it is
an artefact, not a measurement. Fixing it means re-measuring footprints against clipped geometry
rather than bounding boxes.

## Risk scoring

The composite score is a presentation device and is documented as one. Components are split by role:

- **Signal** — unsupported share of the claim (0.60), and separation between the claim and the
  supported range measured in interval half-widths (0.40). Only these carry risk.
- **Confidence** — pre-treatment fit, control match quality, estimate precision. These never create
  risk; they scale it, via `0.35 + 0.65 × mean(fit, quality)`.

Treating fit as a risk component — as the obvious design does — produces a score that rises when the
model is good, so a well-fitted analysis finding a baseline entirely reasonable would outrank a badly
fitted one finding the same thing. Every component is returned separately, so the composite can be
ignored.

## Configuration

Everything tunable is in `config.py` with its reasoning. The defaults that most affect results:

| | default | why |
|---|---|---|
| `exclusion_buffer_km` | 25 | Leakage belt, measured **edge to edge**, not centroid to centroid — two adjacent 1° parcels have centroids 110 km apart and no land between them. |
| `max_distance` | 1.5 | Caliper on weighted standardised distance. Relaxed to `min_matches` when it binds, with the relaxation recorded and propagated into confidence. |
| `max_protected_fraction` | 0.25 | Protected land shows what happens *under* protection. |
| `FEATURE_WEIGHTS` | history 4.0, terrain 1.0 | What land has been doing predicts what it does next far better than how high it is. |
| `covariate_lambda` | 0.25 | Stops the optimiser picking parcels that trace the same curve for unrelated reasons. |
| `n_bootstrap` | 600 | ~2s per project. |

Defaults were chosen against **pre-treatment fit**, which is a pre-treatment quantity, so tuning them
cannot select on the outcome. Expanding the donor pool was tested and did not improve fit; the low
effective-control counts are a property of this pool, not of the settings.

## Not built

Deliberately absent rather than stubbed, because a stub returning plausible numbers is worse than an
honest gap:

- **FastAPI layer.** `AnalysisResult.as_api_dict()` already returns the full response shape and is
  tested for JSON-serialisability; wrapping it is mechanical.
- **PostGIS persistence.** Nothing is stored yet.
- **Raster adapter.** `RasterSource` fixes the interface — nodata, cloud masking, resampling,
  equal-area reprojection all belong behind it — and raises rather than fabricating cover values.
  This is what unlocks 1 km units and non-Brazilian regions.
- **Kariba REDD+.** PRODES is Brazil only. A Zimbabwe project needs a control pool collected for its
  own region. Producing a Kariba figure from Amazon parcels would be fabrication, so there is no
  Kariba notebook.
- **Roads, settlements, population, cropland.** Declared in the covariate registry, returned as
  `None` by the PRODES adapter. The matcher reports matching on 8 covariates rather than 12 instead
  of filling gaps with continental averages.
- **Ex-ante XGBoost risk surface** (Stage 20) and **placebo-calibrated intervals**. The second
  matters more, given the coverage figure above.
