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
export const CASE_STUDIES = [
  {
    projectId: "KARIBA-902",
    headline: "Verra's own review found more than half the credits this project issued did not correspond to real emission reductions.",
    standfirst:
      "Kariba REDD+ (VCS 902) is a real, registered REDD+ project in the Zambezi Valley, Zimbabwe, not an " +
      "illustrative record like the Amazon projects in this build. It is the case Phantom's whole approach is " +
      "modelled on: a baseline written by the project itself, sold against for over a decade, and only checked " +
      "against what comparable land actually did after journalists and the registry went looking.",
    status: "Withdrawn from the Verra registry, May 2024",
    keyFigures: [
      { label: "Project area", value: "≈758,000 ha", source: "carbongreenafrica" },
      { label: "Credits issued", value: "≈27M", source: "reddmonitor-fakecredits" },
      { label: "Credits Verra found unsupported", value: "15.2M (~55%)", source: "reddmonitor-fakecredits" },
      { label: "Project's claimed baseline", value: "3.7% deforestation per year", source: "followthemoney" },
    ],
    timeline: [
      { date: "2011", title: "Kariba REDD+ registered", detail: "VCS 902, developed by Carbon Green Investments/Africa; credits sold internationally via South Pole.", source: "carbongreenafrica" },
      { date: "2023-01", title: "Verra places the project on hold pending investigation", source: "bezero" },
      { date: "2023-10", title: "South Pole ends its relationship with the project", detail: "BeZero Carbon downgrades its rating from BBB to D and delists it.", source: "bezero" },
      { date: "2024-05", title: "Carbon Green Investments formally withdraws Kariba REDD+ from the Verra registry", source: "qcintel" },
      { date: "2025-09", title: "Verra's review concludes", detail: "More than half of the roughly 27 million credits issued did not correspond to real emission reductions.", source: "climatechangenews" },
    ],
    findings: [
      {
        title: "Verra determined the baseline had been substantially overstated",
        body: "Verra's own multi-year review found that about 15.2 million of the roughly 27 million credits the " +
          "project issued, over half of them, did not correspond to real emission reductions, and Verra sought " +
          "compensation from the project's developer, Carbon Green Investments.",
        source: "reddmonitor-fakecredits",
      },
      {
        title: "The project's own claimed deforestation rate",
        body: "Reporting on the project's own maps found its baseline assumed 3.7% of the project area would be " +
          "deforested every year without the project; South Pole's own separate estimate was 3.2% per year.",
        source: "followthemoney",
      },
      {
        title: "Registry and rating history",
        body: "Verra placed the project on hold in January 2023 pending investigation. BeZero Carbon downgraded " +
          "its rating from BBB to D and delisted it in October 2023, the same month South Pole ended its " +
          "involvement. Carbon Green Investments formally withdrew the project from the VCS registry in May 2024.",
        source: "bezero",
      },
    ],
    sources: [
      { id: "climatechangenews", title: "Zimbabwe forest carbon megaproject generated millions of junk credits", publisher: "Climate Home News", url: "https://www.climatechangenews.com/2025/09/30/zimbabwe-forest-carbon-megaproject-generated-millions-of-junk-credits/" },
      { id: "reddmonitor-fakecredits", title: "15.2 million fake carbon credits were sold from the Kariba REDD project according to Verra", publisher: "REDD-Monitor", url: "https://reddmonitor.substack.com/p/152-million-fake-carbon-credits-were" },
      { id: "followthemoney", title: "South Pole and the Kariba REDD+ Project", publisher: "REDD-Monitor, reporting on a Follow the Money investigation", url: "https://reddmonitor.substack.com/p/south-pole-and-the-kariba-redd-project" },
      { id: "bezero", title: "Downgrading Kariba REDD+ Project to D, and Delisting", publisher: "BeZero Carbon", url: "https://bezerocarbon.com/insights/kariba-redd-downgrade-to-d-and-delist" },
      { id: "qcintel", title: "Kariba REDD+ project formally withdraws from Verra registry", publisher: "Quantum Commodity Intelligence", url: "https://www.qcintel.com/carbon/article/kariba-redd-project-formally-withdraws-from-verra-registry-28531.html" },
      { id: "carbongreenafrica", title: "Kariba REDD+ Project", publisher: "Carbon Green Africa", url: "https://carbongreenafrica.net/kariba-redd-project/" },
    ],
    whatWeWouldHaveSeen:
      "The panel above is Phantom's own independent check, not a repeat of Verra's review: it applies the " +
      "project's own reported 3.7%-per-year baseline to a fixed 2016–2019 comparison window against forest " +
      "parcels measured from Hansen/Global Nature Watch data (formerly Global Forest Watch; PRODES, used for the Amazon, does not cover " +
      "Zimbabwe), because that public data only supports comparison through 2019. Verra's own review covered " +
      "the real ~2011–2023 crediting period with its own method. The two are not the same calculation, and both " +
      "are shown because each is a real, independently obtained finding about the same project.",
    disclaimer:
      "This case study reports what Verra and named reporting determined, not Phantom's own conclusion. The " +
      "figures above it on this panel are Phantom's independent estimate, computed the same way as every other " +
      "project in this build, over a different, shorter window than Verra's own review used.",
  },
];

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
