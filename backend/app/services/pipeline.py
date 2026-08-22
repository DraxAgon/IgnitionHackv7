"""The orchestrator: one project in, one analysis out.

The order of the stages is the methodology, so it is written out plainly here
rather than distributed across the modules. Read top to bottom, this function is
the argument the whole platform makes.

The pivot is at stage 8. Everything above it sees only pre-treatment data.
Everything below it uses weights that were already locked. There is no branch
where post-treatment forest data reaches a decision about which controls to use
or how to weight them - not because the code is careful, but because the
functions above the pivot are not given access to it.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Mapping, Sequence

from ..config import DEFAULT_CONFIG, AnalysisConfig
from ..models.analysis_result import AnalysisResult
from ..models.forest_cell import ForestUnit, UnitPool
from ..models.project import CarbonProject
from ..models.provenance import DataProvenance, Provenance, ResultProvenance
from ..utils.temporal import PreTreatmentView, TreatmentTiming, Window
from . import candidate_filter as cf
from . import control_matching as cm
from . import counterfactual as ctf
from . import feature_engineering as fe
from . import forest_service as fs
from . import model_quality as mq
from . import risk_scoring as rs
from . import synthetic_control as sc
from . import trajectory as tj
from . import uncertainty as unc


class ProjectDataError(RuntimeError):
    """The project's own forest record cannot support an analysis.

    Separate from `InsufficientCandidatesError`, which is about the control pool.
    This one says the treated unit itself is unmeasurable, and it exists because
    the alternative is worse than failing: a project whose forest denominator is
    zero produces a loss of 0.0%, a flat pre-treatment trajectory, and a
    counterfactual comparison that looks complete and means nothing.
    """


def _validate_treated_unit(project: CarbonProject, timing: TreatmentTiming) -> None:
    """Refuse to analyse a project whose own forest record is incoherent.

    The specific failure this catches has been seen in real collected data.
    Where forest area is derived by subtracting previously cleared land from a
    bounding box, a large clearing polygon that straddles the boundary is counted
    whole on both sides. Subtract enough of those and the forest baseline goes to
    zero or negative, gets clamped at zero, and every downstream ratio quietly
    returns 0.0 - which reads as a pristine, perfectly protected forest rather
    than as a broken denominator.

    That is the most dangerous possible artefact for this tool, because it points
    the wrong way: it makes a project look maximally successful at avoiding
    deforestation. So it fails loudly here instead.
    """
    unit = project.footprint
    if unit.forest_baseline_km2 <= 0:
        raise ProjectDataError(
            f"{project.project_id} ({project.display_name}): the project footprint has "
            f"a forest baseline of {unit.forest_baseline_km2:.1f} km2 against "
            f"{unit.land_km2:.1f} km2 of land and {unit.prior_cleared_km2:.1f} km2 "
            f"recorded as previously cleared. Prior clearing exceeds the footprint "
            f"itself, which means the source's area aggregation is counting polygons "
            f"that cross the boundary. Every loss fraction for this project would "
            f"divide by zero and return 0%, making an unmeasurable project look "
            f"perfectly protected. Re-measure the footprint with clipped geometry "
            f"rather than a bounding box before analysing it."
        )
    standing = fs.forest_km2_at(unit, timing.effective_post.start)
    if standing <= 0:
        raise ProjectDataError(
            f"{project.project_id}: no forest remained at the start of the observation "
            f"window ({timing.effective_post.start}). There is nothing left to avoid "
            f"losing, so an avoided-deforestation claim cannot be evaluated."
        )
    ok, reason = fs.is_physically_coherent(unit)
    if not ok:
        raise ProjectDataError(
            f"{project.project_id}: the project's forest record is incoherent - {reason}"
        )
    if not fs.has_complete_history(unit, timing.pre_period):
        raise ProjectDataError(
            f"{project.project_id}: the forest record has gaps in the pre-treatment "
            f"window {timing.pre_period.start}-{timing.pre_period.end}. Controls cannot "
            f"be matched to a partial history."
        )


def _resolve_timing(
    project: CarbonProject,
    pool: UnitPool,
    config: AnalysisConfig,
    cutoff_year: int | None,
) -> TreatmentTiming:
    """Work out which years are pre-treatment, observable, and off-limits.

    The last observable year is the earliest of what the data covers and what the
    cutoff allows. For a backtest the cutoff is the whole point: setting it to
    2019 makes the engine behave as though nothing after 2019 had been recorded,
    which is the only way to ask what the system would have said at the time
    without answering with hindsight.
    """
    data_last = min(u.last_year for u in pool.units) if len(pool) else project.footprint.last_year
    data_first = max(u.first_year for u in pool.units) if len(pool) else project.footprint.first_year
    last_year = min(data_last, project.crediting_end_year)
    if cutoff_year is not None:
        last_year = min(last_year, cutoff_year)
    if last_year < project.start_year:
        raise ValueError(
            f"{project.project_id}: no observable years. The project starts in "
            f"{project.start_year} and the analysis is limited to {last_year}."
        )
    return fe.default_timing(
        start_year=project.start_year,
        pre_years=config.pre_period_years,
        last_observed_year=last_year,
        cutoff_year=cutoff_year,
        earliest_data_year=max(data_first, project.footprint.first_year),
    )


def run_project_analysis(
    project: CarbonProject,
    pool: UnitPool,
    config: AnalysisConfig = DEFAULT_CONFIG,
    cutoff_year: int | None = None,
    claim_provenance: DataProvenance | None = None,
    include_bootstrap: bool = True,
) -> AnalysisResult:
    """Run the full independent verification for one project.

    Parameters
    ----------
    cutoff_year
        Analyse as of this year, ignoring everything recorded afterwards.
        `None` uses all available data. This is the mechanism behind Stage 18
        historical backtesting, and it applies to the *whole* pipeline: the
        observation window is truncated, so the counterfactual, the interval and
        the risk score are all what they would have been at the time.
    """
    timing = _resolve_timing(project, pool, config, cutoff_year)
    _validate_treated_unit(project, timing)
    features = tuple(config.matching.features)

    # ---- stage 2-3: measure the treated unit ------------------------------
    # Observed on the project's own footprint. Nothing here feeds control
    # selection; it is one side of a comparison, computed independently.
    observation = Window(timing.effective_post.start, timing.effective_post.end)
    initial_forest = fs.initial_forest_area(project.footprint, observation.start)
    observed = fs.calculate_actual_project_loss(project.footprint, observation)

    # ---- stage 6: eligible untreated land ---------------------------------
    candidates = cf.filter_candidate_controls(
        project=project,
        pool=pool,
        timing=timing,
        config=config.matching,
        minimum=max(config.trajectory.min_controls_retained, 10),
    )

    # ---- stage 7-8: describe and shortlist --------------------------------
    matching = cm.match_controls(project, candidates.units, timing, config.matching)
    if len(matching) < 2:
        raise cf.InsufficientCandidatesError(
            f"{project.project_id}: only {len(matching)} candidates fell within the "
            f"covariate distance limit of {config.matching.max_distance}. Either the "
            f"project is unlike anything in the pool, or the pool is too small."
        )

    # ---- stage 5 and 9: pre-treatment trajectories ------------------------
    # PreTreatmentView raises on any year at or after the project start, so
    # everything from here to the lock cannot read the outcome.
    project_pre: PreTreatmentView = fe.extract_pre_trajectory(project.footprint, timing)
    matched_units: dict[str, ForestUnit] = {m.unit_id: m.unit for m in matching.matches}
    control_pres = {
        uid: fe.extract_pre_trajectory(unit, timing) for uid, unit in matched_units.items()
    }
    traj = tj.filter_by_trajectory(project_pre, control_pres, config.trajectory)
    donors = tuple(traj.kept)
    if len(donors) < 2:
        raise cf.InsufficientCandidatesError(
            f"{project.project_id}: {len(donors)} controls survived trajectory filtering"
        )

    donor_pres = {uid: control_pres[uid] for uid in donors}
    donor_units = {uid: matched_units[uid] for uid in donors}
    control_features = {
        uid: fe.extract_cell_features(unit, timing, features)
        for uid, unit in donor_units.items()
    }

    # ---- stage 10: fit the weights, then lock them ------------------------
    fit = sc.build_synthetic_control(
        project_pre=project_pre,
        control_pres=donor_pres,
        project_features=matching.project_features,
        control_features=control_features,
        scaler=matching.scaler,
        feature_weights=config.matching.weights,
        config=config.synthetic,
    )

    # ======================================================================
    # WEIGHTS ARE LOCKED. Post-treatment data is used from this point on.
    # `fit` is frozen with read-only arrays; nothing below can alter it.
    # ======================================================================

    # ---- stage 11-12: carry the weights forward ---------------------------
    # Stock series run one year past the last year of clearing. The stock at the
    # start of 2024 is what survived 2023, so a window that stops at 2023 counts
    # one fewer year of loss for the counterfactual than `calculate_actual_
    # project_loss` counts for the project - which would understate the
    # counterfactual by about one year in N and report every project as more
    # over-credited than it is.
    stock_observation = Window(observation.start, observation.end + 1)
    full_window = Window(timing.pre_period.start, observation.end + 1)
    anchor = timing.pre_period.start
    synthetic_full = sc.synthetic_series(fit, donor_units, full_window, anchor_year=anchor)
    project_full = fs.remaining_fraction_series(project.footprint, full_window, anchor_year=anchor)
    counterfactual = ctf.calculate_counterfactual_loss(synthetic_full, stock_observation)

    # ---- stage 13-14: compare against the claim ---------------------------
    impact = ctf.calculate_impact(
        counterfactual_loss=counterfactual.loss,
        actual_loss=float(observed["loss_fraction"]),
        claimed_baseline=project.claim.baseline_loss,
    )
    credits = ctf.credit_exposure(
        impact, project.claim.credits_issued, project.claim.price_per_credit
    )

    # ---- stage 15: uncertainty --------------------------------------------
    if include_bootstrap:
        interval = unc.bootstrap_uncertainty(
            project_pre=project_pre,
            control_pres=donor_pres,
            project_features=matching.project_features,
            control_features=control_features,
            control_units=donor_units,
            scaler=matching.scaler,
            feature_weights=config.matching.weights,
            post_window=stock_observation,
            anchor_year=observation.start,
            sc_config=config.synthetic,
            config=config.uncertainty,
            point_estimate=counterfactual.loss,
        )
    else:
        interval = unc.UncertaintyEstimate(
            estimate=counterfactual.loss,
            lower=float("nan"),
            upper=float("nan"),
            confidence=config.uncertainty.confidence,
            n_successful=0,
            n_attempted=0,
            std_error=float("nan"),
        )
    claim_position = unc.claim_outside_interval(project.claim.baseline_loss, interval)

    # ---- stage 16: how much to trust any of this --------------------------
    balance = cm.covariate_balance(
        project_features=matching.project_features,
        before=fe.covariate_table(candidates.units, timing, features),
        after=[control_features[uid] for uid in donors],
        features=matching.features_used,
    )
    distances = {m.unit_id: m.distance for m in matching.matches}
    quality = mq.calculate_model_quality(
        fit=fit,
        units=donor_units,
        match_distances=[distances[cid] for cid in fit.control_ids],
        balance=balance,
        rejection_rate=candidates.rejection_rate,
        interval_width=interval.width if interval.width == interval.width else None,
        bootstrap_convergence=(
            interval.n_successful / interval.n_attempted if interval.n_attempted else 0.0
        ),
        caliper_relaxed=matching.caliper_relaxed,
        trajectory_relaxed=traj.relaxed,
    )

    # ---- stage 19: screening score ----------------------------------------
    risk = rs.calculate_risk_metrics(impact, interval, quality, config.risk)

    timeline = ctf.divergence_timeline(
        project_stock=project_full,
        synthetic_stock=synthetic_full,
        claimed_baseline=project.claim.baseline_loss,
        flux_window=observation,
        claimed_path=project.claim.baseline_path,
    )
    divergence = ctf.first_divergence_year(timeline)

    provenance = ResultProvenance(
        measurement=pool.provenance,
        claim=claim_provenance or project.claim.provenance,
    )

    return AnalysisResult(
        project=project,
        timing=timing,
        provenance=provenance,
        initial_forest=initial_forest,
        observed=observed,
        counterfactual=counterfactual,
        impact=impact,
        interval=interval,
        claim_position=claim_position,
        credits=credits,
        fit=fit,
        matching=matching,
        candidates=candidates,
        trajectory_filter=traj,
        quality=quality,
        risk=risk,
        project_series=project_full,
        synthetic_series=synthetic_full,
        timeline=timeline,
        divergence=divergence,
        balance=balance,
        features_used=matching.features_used,
        config_snapshot={
            "pre_period_years": config.pre_period_years,
            "matching": {
                "max_distance": config.matching.max_distance,
                "n_neighbours": config.matching.n_neighbours,
                "exclusion_buffer_km": config.matching.exclusion_buffer_km,
                "max_protected_fraction": config.matching.max_protected_fraction,
                "min_forest_km2": config.matching.min_forest_km2,
                "feature_weights": dict(config.matching.weights),
            },
            "trajectory": asdict(config.trajectory),
            "synthetic": {
                "covariate_lambda": config.synthetic.covariate_lambda,
                "ridge": config.synthetic.ridge,
            },
            "uncertainty": {
                "n_bootstrap": config.uncertainty.n_bootstrap,
                "confidence": config.uncertainty.confidence,
                "random_seed": config.uncertainty.random_seed,
            },
        },
    )


def run_backtest_series(
    project: CarbonProject,
    pool: UnitPool,
    cutoff_years: Sequence[int],
    config: AnalysisConfig = DEFAULT_CONFIG,
    include_bootstrap: bool = False,
) -> list[dict]:
    """Stage 18: what this analysis would have said, year by year.

    Runs the whole pipeline once per cutoff, each time with everything after that
    year withheld. The output answers a question a buyer actually has - "when
    would this have been visible?" - and it answers it without hindsight, because
    each run genuinely cannot see the years that followed it.

    The bootstrap is off by default here: a dozen cutoffs times several hundred
    refits is slow, and the point of a backtest series is the trajectory of the
    estimate rather than the interval at each step.
    """
    rows: list[dict] = []
    for year in sorted(cutoff_years):
        try:
            result = run_project_analysis(
                project, pool, config=config, cutoff_year=year, include_bootstrap=include_bootstrap
            )
        except (
            ValueError,
            ProjectDataError,
            cf.InsufficientCandidatesError,
            sc.SyntheticControlError,
        ) as exc:
            rows.append({"cutoff_year": year, "error": str(exc)})
            continue
        rows.append(
            {
                "cutoff_year": year,
                "years_observed": result.timing.effective_post.length,
                "counterfactual_loss": round(result.counterfactual.loss, 5),
                "project_loss": round(float(result.observed["loss_fraction"]), 5),
                "claimed_baseline_to_date": round(
                    project.claim.baseline_loss
                    * result.timing.effective_post.length
                    / max(project.crediting_years, 1),
                    5,
                ),
                "supported_fraction": (
                    None
                    if result.impact.supported_fraction is None
                    else round(result.impact.supported_fraction, 5)
                ),
                "risk_score": round(result.risk.score, 1),
                "risk_level": result.risk.level,
                "confidence": result.quality.confidence,
                "effective_controls": round(result.fit.effective_controls, 2),
                "pre_treatment_rmse": round(result.fit.pre_rmse, 5),
            }
        )
    return rows
