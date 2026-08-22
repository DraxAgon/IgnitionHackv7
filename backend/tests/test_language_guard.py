"""The interpretation rules, enforced by the build rather than by good intentions.

This tool compares a projection written by an interested party against an
estimate of something nobody can observe. Both carry real uncertainty. A
discrepancy between them is a discrepancy - it is not fraud, error, or bad faith,
and the difference between saying those things is the difference between a
screening tool and a defamation risk.

Wording drifts. Someone writes "the project overstated its baseline" in an f-string
because it reads better than the careful version, and six months later that string
is in a PDF a buyer sends to a developer. These tests make that a build failure.

The existing JavaScript app enforces the same rule on its case studies through
`validateCaseStudy`; this is the Python equivalent for engine output.
"""

from __future__ import annotations

import ast
import dataclasses
import re
from pathlib import Path

import pytest

from app.config import DEFAULT_CONFIG
from app.models.provenance import DataProvenance, Provenance, ResultProvenance
from app.services.pipeline import run_project_analysis
from tests.fixtures.synthetic_forest import build_scenario

FAST = DEFAULT_CONFIG.with_(
    uncertainty=dataclasses.replace(DEFAULT_CONFIG.uncertainty, n_bootstrap=60)
)

# Words that assert wrongdoing or certainty about an unobservable quantity.
# "inflated" and "overstated" are included as verbs about a party; the neutral
# nouns the brief asks for - "baseline inflation risk", "potential over-crediting",
# "unsupported fraction", "baseline discrepancy" - are what should appear instead.
FORBIDDEN = [
    r"\bfraud\b",
    r"\bfraudulent\b",
    r"\bscam\b",
    r"\blied?\b",
    r"\blying\b",
    r"\bdeceiv",
    r"\bdishonest\b",
    r"\bcriminal\b",
    r"\bguilty\b",
    r"\bcorrupt\b",
    r"\bfake\b",
    r"\bsham\b",
    r"\bgreenwash",
    r"\bmisconduct by\b",
    r"\bthe project (?:overstated|inflated|falsified|misrepresented)\b",
    r"\bdeliberately\b",
    r"\bintentionally (?:overstated|inflated)\b",
    r"\bproven\b",
    r"\bproves\b",
]


def _all_strings(obj) -> list[str]:
    out: list[str] = []
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            out.append(str(k))
            out.extend(_all_strings(v))
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            out.extend(_all_strings(v))
    return out


@pytest.fixture(scope="module")
def payload() -> dict:
    scenario = build_scenario(seed=7, claimed_baseline=0.60)
    result = run_project_analysis(scenario.project, scenario.pool, config=FAST)
    return result.as_api_dict()


def test_no_accusation_language_anywhere_in_the_response(payload):
    """Checked on a maximally adverse case.

    The fixture claims a 60% baseline against a counterfactual near 5%, so this
    is the most damning result the engine can produce. If accusatory wording is
    going to appear anywhere, it appears here.
    """
    text = " ".join(_all_strings(payload)).lower()
    for pattern in FORBIDDEN:
        assert not re.search(pattern, text), (
            f"the response matches {pattern!r}, which asserts wrongdoing rather than "
            f"reporting a statistical discrepancy"
        )


def test_the_findings_are_phrased_as_estimates(payload):
    """Every headline sentence must be a claim about the model, not the project."""
    lines = payload["interpretation"]
    assert lines
    joined = " ".join(lines).lower()
    assert any(
        phrase in joined
        for phrase in ("supports approximately", "this analysis", "estimated", "comparable")
    )
    assert "cannot be observed" in joined


def test_over_crediting_is_always_qualified_as_potential(payload):
    """The brief's wording rule: potential over-crediting, unsupported fraction,
    baseline discrepancy - never a bare assertion."""
    assert "potential_overcrediting" in payload["comparison"]
    text = " ".join(_all_strings(payload)).lower()
    for match in re.finditer(r"over-?crediting", text):
        window = text[max(0, match.start() - 60) : match.end() + 20]
        assert any(
            q in window for q in ("potential", "may", "estimate", "unsupported", "not evidence")
        ), f"unqualified use of over-crediting: ...{window}..."


def test_the_risk_score_carries_its_caveat(payload):
    caveat = payload["risk"]["caveat"].lower()
    assert "screening" in caveat
    assert "not evidence" in caveat or "not a finding" in caveat
    assert payload["risk"]["method"]


def test_uncertainty_is_never_hidden(payload):
    """A point estimate of an unobservable quantity must not be presented alone."""
    ci = payload["independent_analysis"]["counterfactual_ci"]
    assert ci["lower"] is not None and ci["upper"] is not None
    assert ci["lower"] <= payload["independent_analysis"]["counterfactual_loss"] <= ci["upper"]
    assert payload["model_quality"]["confidence"] in ("HIGH", "MODERATE", "LOW")


def test_synthetic_results_are_labelled_as_synthetic(payload):
    assert payload["provenance"]["is_finding"] is False
    assert "SYNTHETIC" in payload["provenance"]["caveat"]


def test_illustrative_claims_cannot_be_presented_as_findings():
    """Real measurements against an invented claim is not a finding about anyone.

    The repository's shipped projects are exactly this case: PRODES-measured
    forest under an illustrative baseline. The caveat has to say so.
    """
    provenance = ResultProvenance(
        measurement=DataProvenance(kind=Provenance.MEASURED, source="INPE PRODES"),
        claim=DataProvenance(kind=Provenance.ILLUSTRATIVE, source="generated"),
    )
    assert provenance.is_finding is False
    assert "illustrative" in provenance.caveat.lower()
    assert "no real project" in provenance.caveat.lower()


def test_a_fully_real_result_is_allowed_to_be_a_finding():
    """The guard must not be so broad that nothing can ever be reported."""
    provenance = ResultProvenance(
        measurement=DataProvenance(kind=Provenance.MEASURED, source="INPE PRODES"),
        claim=DataProvenance(kind=Provenance.REPORTED, source="registry document"),
    )
    assert provenance.is_finding is True
    assert provenance.caveat == ""


def test_the_observed_loss_admits_it_may_not_be_deforestation(payload):
    """Canopy loss includes fire and harvest. Saying so is not optional."""
    caveat = payload["observed"]["caveat"].lower()
    assert "canopy loss" in caveat
    assert "upper bound" in caveat


def _user_facing_literals(path: Path) -> list[tuple[int, str]]:
    """Every string literal in a module that is not a docstring.

    The distinction matters and a text search cannot make it. Docstrings in this
    engine necessarily discuss the words they forbid - `counterfactual.py`
    explains that a discrepancy "is not fraud", and `candidate_filter.py`
    describes silent exclusions as "lying by omission". Those are the rule being
    written down, not the rule being broken.

    Everything else - messages, templates, interpretation sentences, field values
    - can reach a user, so it is held to the rule.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                docstrings.add(id(body[0].value))
        # Bare string expressions are also documentation - the attribute-level
        # docstrings under the Provenance enum members, for instance.
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            if isinstance(node.value.value, str):
                docstrings.add(id(node.value))

    return [
        (node.lineno, node.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


def test_no_user_facing_string_in_the_engine_accuses_anyone():
    """Applies the rule to the code, not only to one sampled response.

    A response test can only check the paths a particular fixture happens to
    exercise. This checks every message the engine could ever emit, including
    error text and branches that only fire on rare data.
    """
    root = Path(__file__).resolve().parents[1] / "app"
    offenders: list[str] = []
    for path in sorted(root.rglob("*.py")):
        for lineno, literal in _user_facing_literals(path):
            lowered = literal.lower()
            for pattern in FORBIDDEN:
                if re.search(pattern, lowered):
                    offenders.append(f"{path.name}:{lineno}: {literal.strip()[:90]}")
    assert not offenders, (
        "user-facing strings assert wrongdoing rather than reporting a discrepancy:\n  "
        + "\n  ".join(offenders)
    )
