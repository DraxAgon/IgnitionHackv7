// actors.js — the parties around a credit, and the paper trail between them.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY NAME IN THIS FILE IS INVENTED.
//
// No real project developer, verification body, registry or corporate buyer is
// named anywhere in this product. The forest data is real; the companies are
// not, and `src/selfcheck.mjs` fails the build if a real one appears here.
//
// The names are deliberately boring. A joke name reads as satire and invites the
// reader to treat the whole screen as a mock-up; a name that is one letter from
// a real firm invites something worse.
// ─────────────────────────────────────────────────────────────────────────────
//
// Why this file exists at all. The interesting thing about a carbon credit is
// not the number, it is the structure that produced the number: a developer
// writes the baseline that determines how many credits it can sell, and then
// pays a verification body to check it. That is not an accusation, it is how the
// market is built — and it is invisible unless the roles are shown separately.

const roleNotes = {
  developer:
    "Builds and operates the project, writes the baseline, and sells the resulting credits. Also engages and pays the verification body.",
  verifier:
    "Independent third party that audits the baseline against the methodology and signs off. A separate legal entity, contracted and paid by the developer.",
  registry:
    "Issues serial numbers, holds the public record, and marks credits as retired once a buyer claims them.",
  buyer:
    "Purchased credits and retired them against a stated climate target. A retired credit cannot be resold or reversed.",
};

export const ROLE_LABEL = {
  developer: "Project developer",
  verifier: "Verification body (VVB)",
  registry: "Registry",
  buyer: "Buyer",
};

export const ACTORS = [
  // ── developers ───────────────────────────────────────────────────────────
  { id: "dev-verdanta", role: "developer", name: "Verdanta Carbon Partners", country: "Singapore" },
  { id: "dev-silvabrasa", role: "developer", name: "Silvabrasa Projetos Florestais", country: "Brazil" },
  { id: "dev-aurorabasin", role: "developer", name: "Aurora Basin Forestry", country: "Netherlands" },

  // ── verification bodies ──────────────────────────────────────────────────
  { id: "vvb-aurum", role: "verifier", name: "Aurum Verification Services", country: "United Kingdom" },
  { id: "vvb-northwind", role: "verifier", name: "Northwind Assurance Group", country: "Canada" },
  { id: "vvb-terraline", role: "verifier", name: "Terraline Certification", country: "Switzerland" },

  // ── registry ─────────────────────────────────────────────────────────────
  { id: "reg-meridian", role: "registry", name: "Meridian Standard Registry", country: "Switzerland" },

  // ── buyers ───────────────────────────────────────────────────────────────
  { id: "buy-aeronova", role: "buyer", name: "Aeronova Air Group", country: "Germany" },
  { id: "buy-kestrel", role: "buyer", name: "Kestrel Freight Systems", country: "United States" },
  { id: "buy-nordhaven", role: "buyer", name: "Nordhaven Consumer Foods", country: "Denmark" },
  { id: "buy-halbrook", role: "buyer", name: "Halbrook Asset Management", country: "United States" },
  { id: "buy-vantor", role: "buyer", name: "Vantor Energy", country: "Norway" },
];

export const actorById = (id) => ACTORS.find((a) => a.id === id) ?? null;
export const noteForRole = (role) => roleNotes[role] ?? "";

/**
 * Who is attached to each project.
 *
 * One verifier signs off several projects from the same developer, which is
 * ordinary in this market and is exactly the relationship a buyer cannot see
 * from a registry listing. `verifierRecord` below turns it into a number — and
 * that number is only worth reading across a portfolio, so every project in
 * projects.js gets an entry here rather than only the featured few. A project
 * with no entry loses its parties block and its credit history, which reads as
 * a hole in the panel rather than as restraint.
 */
export const PARTIES = {
  "PJ-4922": { developer: "dev-verdanta", verifier: "vvb-aurum", registry: "reg-meridian",
               buyers: ["buy-aeronova", "buy-halbrook", "buy-nordhaven"] },
  "PJ-4648": { developer: "dev-verdanta", verifier: "vvb-aurum", registry: "reg-meridian",
               buyers: ["buy-kestrel", "buy-vantor"] },
  "PJ-4237": { developer: "dev-verdanta", verifier: "vvb-aurum", registry: "reg-meridian",
               buyers: ["buy-nordhaven", "buy-halbrook"] },
  "PJ-5059": { developer: "dev-verdanta", verifier: "vvb-aurum", registry: "reg-meridian",
               buyers: ["buy-aeronova", "buy-kestrel", "buy-vantor"] },
  "PJ-5470": { developer: "dev-verdanta", verifier: "vvb-aurum", registry: "reg-meridian",
               buyers: ["buy-halbrook", "buy-nordhaven"] },
  "PJ-4100": { developer: "dev-silvabrasa", verifier: "vvb-northwind", registry: "reg-meridian",
               buyers: ["buy-aeronova", "buy-kestrel"] },
  "PJ-4374": { developer: "dev-silvabrasa", verifier: "vvb-northwind", registry: "reg-meridian",
               buyers: ["buy-vantor"] },
  "PJ-5196": { developer: "dev-silvabrasa", verifier: "vvb-northwind", registry: "reg-meridian",
               buyers: ["buy-kestrel", "buy-halbrook"] },
  "PJ-5607": { developer: "dev-silvabrasa", verifier: "vvb-northwind", registry: "reg-meridian",
               buyers: ["buy-aeronova", "buy-vantor"] },
  "PJ-4511": { developer: "dev-aurorabasin", verifier: "vvb-terraline", registry: "reg-meridian",
               buyers: ["buy-halbrook", "buy-nordhaven"] },
  "PJ-4785": { developer: "dev-aurorabasin", verifier: "vvb-terraline", registry: "reg-meridian",
               buyers: ["buy-aeronova"] },
  "PJ-5333": { developer: "dev-aurorabasin", verifier: "vvb-terraline", registry: "reg-meridian",
               buyers: ["buy-nordhaven"] },
  "PJ-5744": { developer: "dev-aurorabasin", verifier: "vvb-terraline", registry: "reg-meridian",
               buyers: ["buy-kestrel", "buy-aeronova"] },
};

export const partiesFor = (projectId) => PARTIES[projectId] ?? null;

/** Deterministic 0–1 sequence, so shares are stable across reloads. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Split a total into `n` shares that sum to exactly the total.
 *
 * The last share absorbs the rounding remainder. Without that the buyer rows
 * add up to a number slightly different from the retirement figure above them,
 * which is the sort of small inconsistency that makes a reader stop trusting
 * everything else on the screen.
 */
function shares(total, n, seed) {
  const rand = seeded(seed);
  const weights = Array.from({ length: n }, () => 0.55 + rand());
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.round((w / sum) * total));
  out[n - 1] = total - out.slice(0, -1).reduce((a, b) => a + b, 0);
  return out;
}

/** Deterministic per-project seed, so a split never moves between reloads. */
const seedOf = (project) => Number(String(project.id).replace(/[^0-9]/g, "")) || 1;

/**
 * The region a purchase is attributed to.
 *
 * Credits are sold against a place, and "N credits in the Amazon" is not a
 * place — it is a category. The locality is the finest name the project record
 * actually carries, so it is the finest name a buyer can be held to.
 */
export const regionOf = (project) => project.locality || project.shortName || project.name;

/**
 * The one sentence an attributed purchase is written as, everywhere.
 *
 * The panel, the map popup and the PDF all read from this, so a buyer comparing
 * the screen against the file they downloaded is comparing identical wording.
 * Credits are grouped in full rather than abbreviated: "128K credits" is a
 * summary, and this line is the thing itself.
 */
export const purchaseSentence = ({ actor, credits, region }) =>
  `${actor.name} purchased ${credits.toLocaleString("en-US")} credits in ${region}.`;

/**
 * The chain of custody for one project, derived from its own figures.
 *
 * Nothing here is a free-floating invented number: issuance and retirement
 * volumes come from the project record, buyer shares are a deterministic split
 * of the retired total, and the flag date comes from the divergence timeline the
 * analysis actually produced. Change the project data and the ledger follows.
 *
 * @param {object} project      the project record
 * @param {number|null} flagYear first year the evidence stopped supporting the claim
 */
export function buildLedger(project, flagYear = null) {
  const p = PARTIES[project.id];
  if (!p) return [];
  const start = project.startYear;
  const price = project.pricePerCredit ?? 5.69;
  const issued = project.creditsIssued;
  const retired = project.creditsRetired;
  const seed = seedOf(project);
  const region = regionOf(project);

  // Issuance is split across two vintages, which is how a crediting period of
  // this length is normally drawn down rather than claimed in one block.
  const firstTranche = Math.round(issued * 0.55);
  const secondTranche = issued - firstTranche;

  const events = [
    {
      date: `${start - 1}-11`,
      type: "validation",
      actorId: p.verifier,
      label: "Baseline validated",
      detail: "Reference-area baseline audited against the methodology and signed off.",
    },
    {
      date: `${start}-03`,
      type: "issuance",
      actorId: p.registry,
      credits: firstTranche,
      vintage: start,
      label: "First issuance",
      detail: `${firstTranche.toLocaleString("en-US")} credits issued against the validated baseline.`,
    },
  ];

  const buyerIds = p.buyers;
  const buyerShares = shares(retired, buyerIds.length, seed);

  events.push({
    date: `${start + 2}-06`,
    type: "verification",
    actorId: p.verifier,
    label: "Periodic verification",
    detail: "Same verification body re-confirms the baseline for the next crediting tranche.",
  });

  events.push({
    date: `${start + 2}-09`,
    type: "issuance",
    actorId: p.registry,
    credits: secondTranche,
    vintage: start + 2,
    label: "Second issuance",
    detail: `${secondTranche.toLocaleString("en-US")} further credits issued.`,
  });

  buyerIds.forEach((id, i) => {
    events.push({
      date: `${start + 3 + i}-0${Math.min(9, 4 + i)}`,
      type: "sale",
      actorId: id,
      credits: buyerShares[i],
      priceUsd: Math.round(buyerShares[i] * price),
      region,
      label: "Purchased",
      detail:
        purchaseSentence({ actor: actorById(id), credits: buyerShares[i], region }) +
        ` Bought at about $${price.toFixed(2)} a credit.`,
    });
    events.push({
      date: `${start + 4 + i}-12`,
      type: "retirement",
      actorId: id,
      credits: buyerShares[i],
      region,
      label: "Retired",
      detail: "Claimed against a stated climate target. Cannot be resold or reversed.",
    });
  });

  if (flagYear) {
    events.push({
      date: `${flagYear}-12`,
      type: "phantom_flag",
      actorId: null,
      label: "Evidence stopped supporting the baseline",
      detail:
        "Comparable unprotected land had been clearing at under half the claimed pace " +
        "for two consecutive years by this point.",
    });
  }

  // Chronological, so the flag lands between the issuances and retirements it
  // precedes rather than being appended at the end where it proves nothing.
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Who bought this project's credits, how many, and in which region.
 *
 * Credits per region was never the actionable number — a region cannot be asked
 * about its due diligence and a company can. Every row carries the purchasing
 * company, so the table, the map popup and the PDF all name a party rather than
 * a place. The shares are a deterministic split of the retired total and
 * reconcile to it exactly; `selfcheck.mjs` asserts that.
 */
export const purchaseRows = (project) => {
  const p = PARTIES[project.id];
  if (!p) return [];
  const region = regionOf(project);
  const price = project.pricePerCredit ?? 5.69;
  const split = shares(project.creditsRetired, p.buyers.length, seedOf(project));
  return p.buyers.map((id, i) => {
    const row = {
      actor: actorById(id),
      credits: split[i],
      region,
      priceUsd: Math.round(split[i] * price),
    };
    return { ...row, sentence: purchaseSentence(row) };
  });
};

/** Everything bought against one project, as one line. */
export const purchaseSummary = (project) => {
  const rows = purchaseRows(project);
  if (!rows.length) return null;
  const credits = rows.reduce((t, r) => t + r.credits, 0);
  return { rows, credits, region: rows[0].region, buyers: rows.length };
};

/**
 * What a verification body's record looks like across this dataset.
 *
 * The number a buyer would most like to have and cannot get: how many of these
 * projects this VVB signed off, and how far their baselines sat from what
 * comparable land actually did. It is a property of the dataset, not a judgement
 * about the firm, and it is computed from the audits rather than asserted.
 *
 * @param {string} verifierId
 * @param {(id: string) => {discrepancyPts: number}} auditForProject
 */
export function verifierRecord(verifierId, auditForProject) {
  const ids = Object.keys(PARTIES).filter((pid) => PARTIES[pid].verifier === verifierId);
  const audits = ids.map(auditForProject).filter(Boolean);
  if (!audits.length) return null;
  const mean = audits.reduce((s, a) => s + a.discrepancyPts, 0) / audits.length;
  const developers = new Set(ids.map((pid) => PARTIES[pid].developer));
  return {
    projects: ids.length,
    developers: developers.size,
    meanDiscrepancyPts: mean,
  };
}
