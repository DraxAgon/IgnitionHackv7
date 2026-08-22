// caseStudies.js — deep, sourced write-ups for the handful of projects worth
// stopping on during a demo.
//
// DELIBERATELY EMPTY. The research is being done separately; this file is the
// container it drops into. Add an object to CASE_STUDIES and the project's
// panel grows a "Case study" section automatically — no other file changes.
//
// ─────────────────────────────────────────────────────────────────────────────
// RULES FOR ANYTHING ADDED HERE
//
// These entries are the only place the app makes claims about the real world,
// so they carry the whole legal and factual risk surface. Three hard rules:
//
//  1. EVERY factual claim cites a source. `sources` is not optional. If a fact
//     has no citation it does not go in.
//  2. Report what a named body DETERMINED or PUBLISHED, never what you infer.
//     "Verra determined X and cancelled Y credits, [source]" is reporting.
//     "Project X defrauded buyers" is an allegation. Only the first is allowed.
//  3. Buyers are not defendants. A company that purchased certified credits in
//     good faith did not create the baseline. Describe purchases neutrally and
//     never imply a buyer knew, intended, or benefited from a bad baseline.
//     `validateCaseStudy` rejects the obvious accusation words for this reason.
//
// The point of the product is that buyers have no practical way to check a
// baseline before purchase. That framing makes them the customer, not the
// villain, and it happens to be both the safer and the truer story.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CaseStudy
 * @property {string}  projectId    project this attaches to (must exist in projects.js)
 * @property {string}  headline     short, factual. "What the record shows", not a verdict.
 * @property {string}  standfirst   one paragraph of orientation for a viewer with no context
 * @property {string}  [status]     e.g. "Credits cancelled by registry", "Under review"
 * @property {{label:string,value:string,note?:string,source?:string}[]} keyFigures
 *           the numbers to put on screen. `source` is a key into `sources`.
 * @property {{date:string,title:string,detail?:string,source?:string}[]} timeline
 *           chronology. `date` may be a year ("2011") or a month ("2023-10").
 * @property {{title:string,body:string,source?:string}[]} findings
 *           what a named body actually concluded, each attributed.
 * @property {{text:string,attribution:string,source?:string}[]} [quotes]
 *           direct quotations only, verbatim, with attribution.
 * @property {{id:string,title:string,publisher:string,url:string,accessed?:string}[]} sources
 * @property {string}  [whatWeWouldHaveSeen]
 *           how this project's baseline compares to the independent one, in plain words.
 * @property {string}  [disclaimer] shown verbatim beneath the study
 */

/** @type {CaseStudy[]} */
export const CASE_STUDIES = [];

/** The shape, spelled out. Copy this, fill it, push it into CASE_STUDIES. */
export const CASE_STUDY_TEMPLATE = {
  projectId: "",
  headline: "",
  standfirst: "",
  status: "",
  keyFigures: [{ label: "", value: "", note: "", source: "" }],
  timeline: [{ date: "", title: "", detail: "", source: "" }],
  findings: [{ title: "", body: "", source: "" }],
  quotes: [{ text: "", attribution: "", source: "" }],
  sources: [{ id: "", title: "", publisher: "", url: "", accessed: "" }],
  whatWeWouldHaveSeen: "",
  disclaimer: "",
};

// Words that turn reporting into an allegation. Blocked in narrative fields.
const ACCUSATION_WORDS = [
  "fraud", "fraudulent", "defraud", "scam", "scammed", "swindle",
  "criminal", "conspiracy", "lied", "lying", "deceived", "corrupt",
];

/**
 * Structural + safety check. Called by selfcheck so a malformed or unsourced
 * study fails the build rather than reaching a viewer.
 * @returns {string[]} problems, empty if the study is fit to publish
 */
export function validateCaseStudy(cs, knownProjectIds = []) {
  const problems = [];
  const req = (cond, msg) => !cond && problems.push(msg);

  req(cs.projectId, "projectId is required");
  req(!knownProjectIds.length || knownProjectIds.includes(cs.projectId), `projectId "${cs.projectId}" has no matching project`);
  req(cs.headline?.length > 0, "headline is required");
  req(cs.standfirst?.length > 0, "standfirst is required");
  req(Array.isArray(cs.sources) && cs.sources.length > 0, "at least one source is required");

  const sourceIds = new Set((cs.sources ?? []).map((s) => s.id));
  for (const s of cs.sources ?? []) {
    req(s.id && s.title && s.publisher && s.url, `source "${s.id || "?"}" needs id, title, publisher and url`);
    req(!s.url || /^https:\/\//.test(s.url), `source "${s.id}" url must be https`);
  }

  // Every attributed block must point at a source that exists.
  for (const [field, rows] of [["keyFigures", cs.keyFigures], ["timeline", cs.timeline], ["findings", cs.findings], ["quotes", cs.quotes]]) {
    for (const r of rows ?? []) {
      if (r.source) req(sourceIds.has(r.source), `${field}: unknown source "${r.source}"`);
    }
  }
  // Findings and quotes are the load-bearing claims; they must be attributed.
  for (const f of cs.findings ?? []) req(f.source, `finding "${f.title}" must cite a source`);
  for (const q of cs.quotes ?? []) req(q.source, `quote "${(q.text ?? "").slice(0, 30)}..." must cite a source`);

  const narrative = [cs.headline, cs.standfirst, cs.whatWeWouldHaveSeen,
    ...(cs.findings ?? []).map((f) => `${f.title} ${f.body}`),
    ...(cs.timeline ?? []).map((t) => `${t.title} ${t.detail ?? ""}`)].join(" ").toLowerCase();
  for (const w of ACCUSATION_WORDS)
    if (new RegExp(`\\b${w}\\b`).test(narrative))
      problems.push(`narrative uses "${w}" — report what a named body determined instead, or quote it directly`);

  return problems;
}

export const caseStudyFor = (projectId) => CASE_STUDIES.find((c) => c.projectId === projectId) ?? null;
