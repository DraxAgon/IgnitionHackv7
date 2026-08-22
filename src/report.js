// report.js — the report as a file a buyer can send to someone else.
//
// Everything on screen is behind a click, a hover and a scroll position. A
// procurement decision is not made there; it is made in a meeting, from a
// document, by people who will never open this application. So the export is
// the report — the same figures, the same wording, the same map, in the order
// the panel puts them in — and not a screenshot of a panel.
//
// Two deliberate departures from the screen:
//
//   It is printed on white. The interface is dark because it sits under
//   satellite imagery; a dark PDF is four pages of solid ink and unreadable on
//   paper. The three colours that carry meaning are kept and darkened to hold
//   their contrast on white — amber project, slate comparable, red loss — so
//   nothing changes meaning on the way out.
//
//   It states what it is on every page. A page that names companies and credit
//   volumes will be forwarded without the screen it came from, so the line
//   saying those records are illustrative travels in the footer rather than
//   staying behind in a tooltip.
//
// No figure is recomputed here. They arrive already audited, and they are
// formatted through src/format.js, which the panel also reads.

import { WINDOW, REFERENCE_PERIOD, COVARIATES } from "./baseline.js";
import { ROLE_LABEL, actorById, partiesFor, purchaseRows } from "./actors.js";
import { pct, pts, compact, full, fullMoney } from "./format.js";

/* ── paper ──────────────────────────────────────────────────────────────── */

const PAGE = { w: 210, h: 297, margin: 16, top: 17, bottom: 20 };
const W = PAGE.w - PAGE.margin * 2;
const X = PAGE.margin;

const INK = "#101619";
const INK2 = "#4d5a63";
const INK3 = "#7d8b95";
const RULE = "#d7dee3";
const TINT = "#f3f6f8";

// The three colours that carry meaning, moved onto paper. The screen values are
// tuned to sit on near-black and lose most of their weight on white.
const LOSS = "#c8341f";
const CONTROL = "#2d6a80";
const PROJECT = "#9a6c05";

/** Darken a hex toward black, so a risk band keeps its identity on white. */
function onPaper(hex, amount = 0.24) {
  const h = String(hex).replace("#", "");
  const full6 = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = parseInt(full6, 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - amount)));
  return "#" + channels.map((v) => v.toString(16).padStart(2, "0")).join("");
}

// jsPDF's built-in fonts are WinAnsi, which has no true minus sign, no en dash
// and no arrows. Anything outside it renders as the wrong glyph, so the few
// typographic characters this application actually uses are folded on the way
// in. Accented Latin is in WinAnsi and passes through untouched.
const SUBSTITUTIONS = {
  "−": "-", "–": "-", "—": "-",
  "‘": "'", "’": "'", "“": '"', "”": '"',
  "→": "->", "≥": ">=", "≤": "<=", "×": "x",
  "…": "...", "■": "", "✓": "+",
};
const SUBSTITUTABLE = new RegExp("[" + Object.keys(SUBSTITUTIONS).join("") + "]", "g");
const safe = (value) => String(value ?? "").replace(SUBSTITUTABLE, (c) => SUBSTITUTIONS[c] ?? "");

/* ── the file name ──────────────────────────────────────────────────────── */

// Accented Latin is folded by hand rather than by normalising and stripping
// combining marks: this runs over project names, and a name that comes out as
// "aripuan-a" because a stray mark became a separator is worse than one that
// keeps its letters.
const FOLD = {
  "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a",
  "ç": "c", "è": "e", "é": "e", "ê": "e", "ë": "e",
  "ì": "i", "í": "i", "î": "i", "ï": "i", "ñ": "n",
  "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o",
  "ù": "u", "ú": "u", "û": "u", "ü": "u", "ý": "y",
};

export const slug = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, (c) => FOLD[c] ?? "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Local date, not UTC: the file is named for the day the reader is having. */
export const isoDate = (d = new Date()) =>
  [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((n, i) => String(n).padStart(i ? 2 : 4, "0"))
    .join("-");

/** {report-name}-{date}.pdf */
export const reportFileName = (project, date = new Date()) =>
  `${slug(project.name)}-${isoDate(date)}.pdf`;

/* ── a cursor down the page ─────────────────────────────────────────────── */

function sheet(doc) {
  const s = {
    y: PAGE.top,

    /** Flowing text, wrapped, that breaks to a new page when it runs out. */
    text(str, opts = {}) {
      const { size = 9.5, style = "normal", color = INK, x = X, width = W, align, lead = 1.35 } = opts;
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(color);
      const lineHeight = (size * lead) / 2.835; // pt -> mm
      for (const line of doc.splitTextToSize(safe(str), width)) {
        s.need(lineHeight);
        const anchor = align === "right" ? x + width : align === "center" ? x + width / 2 : x;
        doc.text(line, anchor, s.y + lineHeight * 0.72, { align: align ?? "left" });
        s.y += lineHeight;
      }
      return s;
    },

    /** A section heading, in the panel's own voice. */
    heading(str) {
      s.need(15);
      s.gap(3);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.6);
      doc.setTextColor(INK3);
      doc.text(safe(str).toUpperCase(), X, s.y + 2.4, { charSpace: 0.35 });
      s.y += 4.2;
      doc.setDrawColor(RULE);
      doc.setLineWidth(0.25);
      doc.line(X, s.y, X + W, s.y);
      s.y += 3.4;
      return s;
    },

    gap(mm = 3) {
      s.y += mm;
      return s;
    },

    /** Start a new page if `mm` of block will not fit on this one. */
    need(mm) {
      if (s.y + mm > PAGE.h - PAGE.bottom) {
        doc.addPage();
        s.y = PAGE.top;
      }
      return s;
    },
  };
  return s;
}

/* ── blocks, in the order the panel puts them in ────────────────────────── */

function header(doc, s, project, audit, generated) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(INK);
  doc.text("PHANTOM", X, s.y + 3, { charSpace: 1.5 });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.6);
  doc.setTextColor(INK3);
  doc.text("INDEPENDENT BASELINE VERIFICATION", X + 28, s.y + 3, { charSpace: 0.4 });
  doc.text(safe(isoDate(generated)), X + W, s.y + 3, { align: "right" });
  s.y += 6;
  doc.setDrawColor(INK);
  doc.setLineWidth(0.5);
  doc.line(X, s.y, X + W, s.y);
  s.gap(5.5);

  s.text(project.name, { size: 17, style: "bold" });
  s.gap(0.8);
  s.text(
    [
      project.locality,
      project.country,
      compact(project.areaHa) + " ha",
      "start " + project.startYear,
      project.methodology,
      project.registry,
    ]
      .filter(Boolean)
      .join(" · "),
    { size: 8.4, color: INK2 }
  );
  s.gap(2.6);

  // The risk band, as a bordered pill in the band's own colour.
  const band = onPaper(audit.band.color);
  const label = safe(audit.band.label + " baseline risk");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setDrawColor(band);
  doc.setLineWidth(0.4);
  doc.roundedRect(X, s.y, doc.getTextWidth(label) + 6, 5.6, 1.2, 1.2, "S");
  doc.setTextColor(band);
  doc.text(label, X + 3, s.y + 3.8);
  s.y += 5.6;
  s.gap(4);
}

function verdict(doc, s, result) {
  const { audit, cf, observedInside } = result;
  const line =
    audit.creditsUnsupported > 0
      ? `${compact(audit.creditsUnsupported)} of ${compact(audit.creditsIssued)} credits are not supported by satellite evidence.`
      : "The claimed baseline is consistent with what comparable land actually did.";

  s.text(line, { size: 13.5, style: "bold", color: onPaper(audit.band.color), lead: 1.28 });
  s.gap(1.4);
  s.text(
    `Over ${WINDOW[0]}–${WINDOW[1]}, measured against ${cf.n} comparable unprotected parcels. ` +
      `The project's own area lost ${pct(observedInside)}.`,
    { size: 8.4, color: INK2 }
  );
  s.gap(4);

  const cells = [
    { k: "Project's baseline", v: pct(audit.claimed), c: LOSS },
    { k: "Independent estimate", v: pct(audit.independent), c: CONTROL },
    { k: "Discrepancy", v: pts(audit.discrepancyPts), c: onPaper(audit.band.color) },
  ];
  const cw = W / 3;
  s.need(17);
  cells.forEach((cell, i) => {
    const cx = X + cw * i;
    doc.setFillColor(TINT);
    doc.rect(cx, s.y, cw - (i < 2 ? 1.2 : 0), 16, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor(INK3);
    doc.text(safe(cell.k).toUpperCase(), cx + 3, s.y + 5, { charSpace: 0.25 });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(cell.c);
    doc.text(safe(cell.v), cx + 3, s.y + 12.4);
  });
  s.y += 16;
  s.gap(3);
}

function mapBlock(doc, s, mapImage, year) {
  s.heading("The evidence on the ground");
  if (!mapImage?.dataUrl) {
    s.text(
      "The map could not be captured for this export. Every figure in this report is measured " +
        "independently of it.",
      { size: 8.4, color: INK3 }
    );
    s.gap(2);
    return;
  }

  // Fitted into a fixed band, so the report paginates the same way whatever
  // window shape it was exported from.
  const maxH = 92;
  const ratio = mapImage.height / mapImage.width;
  const w = Math.min(W, maxH / ratio);
  const h = w * ratio;
  const x = X + (W - w) / 2;
  s.need(h + 14);
  doc.addImage(mapImage.dataUrl, "JPEG", x, s.y, w, h, undefined, "FAST");
  doc.setDrawColor(RULE);
  doc.setLineWidth(0.3);
  doc.rect(x, s.y, w, h, "S");
  s.y += h + 2.6;

  // The same legend the screen shows, so the picture reads the same way.
  const keys = [
    { c: PROJECT, t: "project boundary" },
    { c: CONTROL, t: "comparable parcels" },
    { c: LOSS, t: "forest cleared by " + year },
  ];
  let kx = X;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.4);
  for (const k of keys) {
    doc.setFillColor(k.c);
    doc.rect(kx, s.y + 0.6, 2.4, 2.4, "F");
    doc.setTextColor(INK2);
    doc.text(safe(k.t), kx + 3.6, s.y + 2.7);
    kx += doc.getTextWidth(safe(k.t)) + 12;
  }
  s.y += 5;
  s.text(
    `Sentinel-2 cloudless imagery by EOX. Clearing polygons are INPE PRODES, tagged with the year ` +
      `they were detected and shown to ${year}.`,
    { size: 7.4, color: INK3 }
  );
  s.gap(1);
}

function chart(doc, s, timeline, year) {
  s.heading("Claimed pace against comparable land");

  // Truncated at the year the map is showing, exactly as the panel does it, so
  // the file and the screen it came from are never describing different points
  // in time. The scale stays fixed to the whole window, so bars do not rescale
  // as the reader scrubs.
  const rows = timeline.rows.filter((r) => r.year <= year);
  const scale = Math.max(...timeline.rows.map((r) => Math.max(r.claimed, r.observed))) * 1.1 || 1;

  const labelW = 11;
  const statusW = 24;
  const barW = W - labelW - statusW;

  for (const r of rows) {
    s.need(8);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.8);
    doc.setTextColor(INK3);
    doc.text(String(r.year), X, s.y + 3.4);

    doc.setFillColor(LOSS);
    doc.rect(X + labelW, s.y + 0.6, Math.max(0.4, (r.claimed / scale) * barW), 1.7, "F");
    doc.setFillColor(CONTROL);
    doc.rect(X + labelW, s.y + 3.1, Math.max(0.4, (r.observed / scale) * barW), 1.7, "F");

    doc.setFontSize(6.8);
    doc.setTextColor(INK3);
    doc.text(safe(r.status).toUpperCase(), X + W, s.y + 3.4, { align: "right", charSpace: 0.2 });
    s.y += 6.4;
  }

  s.gap(1.2);
  s.need(6);
  let lx = X;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.4);
  for (const k of [{ c: LOSS, t: "claimed" }, { c: CONTROL, t: "comparable unprotected land" }]) {
    doc.setFillColor(k.c);
    doc.rect(lx, s.y + 0.6, 2.4, 2.4, "F");
    doc.setTextColor(INK2);
    doc.text(safe(k.t), lx + 3.6, s.y + 2.7);
    lx += doc.getTextWidth(safe(k.t)) + 12;
  }
  s.y += 5;

  if (timeline.firstFlagYear) {
    s.need(14);
    doc.setFillColor("#fdf6e3");
    doc.setDrawColor("#e0c168");
    doc.setLineWidth(0.3);
    doc.rect(X, s.y, W, 11.5, "FD");
    s.y += 2.6;
    s.text(
      `Detectable from ${timeline.firstFlagYear} — ${timeline.yearsOfWarning} years before the window ` +
        `closed, while credits were still being issued and retired.`,
      { size: 8.2, color: "#6b5310", x: X + 3, width: W - 6 }
    );
    s.y += 2.4;
  }
  s.gap(1.5);
}

function exposure(doc, s, audit) {
  s.heading("Exposure");
  const cells = [
    { k: "Credits not supported", v: full(audit.creditsUnsupported) },
    { k: `At $${audit.pricePerCredit.toFixed(2)} a credit`, v: fullMoney(audit.valueUnsupported) },
  ];
  const cw = W / 2;
  s.need(16);
  cells.forEach((cell, i) => {
    const cx = X + cw * i;
    doc.setFillColor(TINT);
    doc.rect(cx, s.y, cw - (i < 1 ? 1.2 : 0), 15, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor(INK3);
    doc.text(safe(cell.k).toUpperCase(), cx + 3, s.y + 5, { charSpace: 0.25 });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12.5);
    doc.setTextColor(onPaper(audit.band.color));
    doc.text(safe(cell.v), cx + 3, s.y + 11.8);
  });
  s.y += 15;
  s.gap(2);
  s.text(
    `${full(audit.creditsRetired)} of the ${full(audit.creditsIssued)} credits issued are already retired ` +
      `against buyers' targets and cannot be reversed.`,
    { size: 8.2, color: INK2 }
  );
  s.gap(1);
}

/**
 * Who bought the credits.
 *
 * Credits per region was never the actionable number: a region cannot be asked
 * what diligence it did, and a company can. Every row names the purchasing
 * company, and the wording comes from the same place the panel and the map
 * popup read it from, so the three cannot drift apart.
 */
function purchases(doc, s, rows) {
  if (!rows.length) return;
  s.heading("Credit purchases");

  const valueW = 28;
  const lineW = W - valueW;

  for (const row of rows) {
    s.need(8);
    const name = safe(row.actor.name);
    const rest = safe(` purchased ${full(row.credits)} credits in ${row.region}.`);

    // Shrunk to fit rather than wrapped: one purchase is one line, so the column
    // of values beside it stays readable as a column.
    let size = 9.2;
    while (size > 6.8) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(size);
      const nameW = doc.getTextWidth(name);
      doc.setFont("helvetica", "normal");
      if (nameW + doc.getTextWidth(rest) <= lineW) break;
      size -= 0.4;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    doc.setTextColor(INK);
    doc.text(name, X, s.y + 3.4);
    const after = X + doc.getTextWidth(name);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(INK2);
    doc.text(rest, after, s.y + 3.4);

    doc.setFontSize(8.6);
    doc.setTextColor(INK2);
    doc.text(safe(fullMoney(row.priceUsd)), X + W, s.y + 3.4, { align: "right" });

    s.y += 5.4;
    doc.setDrawColor(RULE);
    doc.setLineWidth(0.2);
    doc.line(X, s.y, X + W, s.y);
    s.y += 1.6;
  }

  const credits = rows.reduce((t, r) => t + r.credits, 0);
  const value = rows.reduce((t, r) => t + r.priceUsd, 0);
  s.need(7);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.6);
  doc.setTextColor(INK);
  doc.text(
    safe(
      `${rows.length} ${rows.length === 1 ? "company" : "companies"} · ` +
        `${full(credits)} credits in ${rows[0].region}`
    ),
    X,
    s.y + 3.2
  );
  doc.text(safe(fullMoney(value)), X + W, s.y + 3.2, { align: "right" });
  s.y += 5.5;
  s.gap(1);
  s.text(
    "Purchased and retired against the buyers' own climate targets. A retired credit cannot be " +
      "resold or reversed.",
    { size: 7.6, color: INK3 }
  );
}

function parties(doc, s, project, record) {
  const p = partiesFor(project.id);
  if (!p) return;
  s.heading("Who signed this off");

  const rows = [
    [ROLE_LABEL.developer, actorById(p.developer), "wrote the baseline and sells the credits"],
    [
      ROLE_LABEL.verifier,
      actorById(p.verifier),
      record
        ? `engaged and paid by the developer · signed off ${record.projects} projects here, ` +
          `averaging ${pts(record.meanDiscrepancyPts)} discrepancy`
        : "engaged and paid by the developer",
    ],
    [ROLE_LABEL.registry, actorById(p.registry), "holds the retirement record"],
  ];

  for (const [role, actor, note] of rows) {
    if (!actor) continue;
    s.need(14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor(INK3);
    doc.text(safe(role).toUpperCase(), X, s.y + 2.6, { charSpace: 0.25 });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.4);
    doc.setTextColor(INK);
    doc.text(safe(actor.name), X, s.y + 7);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.6);
    doc.setTextColor(INK2);
    doc.text(safe(actor.country + " · " + note), X, s.y + 10.6, { maxWidth: W });
    s.y += 13;
    doc.setDrawColor(RULE);
    doc.setLineWidth(0.2);
    doc.line(X, s.y - 1.4, X + W, s.y - 1.4);
  }
  s.gap(1);
}

function method(doc, s, result) {
  s.heading("How this was measured");
  s.text(
    `The project's parcel is described by ${COVARIATES.length} characteristics measured over ` +
      `${REFERENCE_PERIOD[0]}–${REFERENCE_PERIOD[1]}, before the crediting window opened, so nothing ` +
      `about the outcome can leak into the comparison. Unprotected parcels resembling it are then observed ` +
      `over ${WINDOW[0]}–${WINDOW[1]}. ${result.matches.length} matched from ${result.considered} ` +
      `candidates; parcels within 1.5° are excluded so displaced clearing cannot flatter the result.`,
    { size: 8, color: INK2 }
  );
  s.gap(1.6);
  s.text(
    "Deforestation is INPE PRODES, the official Brazilian Amazon record. This is a screening estimate " +
      "from public data. It is not an audit, and it is not a determination about any party.",
    { size: 8, color: INK2 }
  );
  s.gap(1.6);
  s.text(
    "Project records, company names and credit volumes in this build are illustrative and describe no " +
      "real party. The deforestation measured under and around the project is real.",
    { size: 8, style: "bold", color: INK2 }
  );
}

function footers(doc, project, generated) {
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(RULE);
    doc.setLineWidth(0.25);
    doc.line(X, PAGE.h - 14, X + W, PAGE.h - 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor(INK3);
    doc.text(
      safe(
        `Phantom · ${project.name} · generated ${isoDate(generated)} · ` +
          `illustrative company records, measured forest data`
      ),
      X,
      PAGE.h - 10.2
    );
    doc.text(`${i} / ${pages}`, X + W, PAGE.h - 10.2, { align: "right" });
  }
}

/* ── the export ─────────────────────────────────────────────────────────── */

/**
 * Build the report for one project and hand it to the browser as a download.
 *
 * @param {object}  opts.project   the project record
 * @param {object}  opts.result    the audit, as the panel already computed it
 * @param {number}  opts.year      the year the map and the timeline are showing
 * @param {object=} opts.mapImage  { dataUrl, width, height } captured by MapView
 * @param {object=} opts.record    the verification body's portfolio record
 * @returns {Promise<string>} the file name written
 */
export async function downloadReport({ project, result, year, mapImage, record }) {
  // Loaded on demand. jsPDF is the largest dependency in the application and
  // most sessions never export anything, so it stays out of the first paint.
  const { jsPDF } = await import("jspdf");

  const generated = new Date();
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  const s = sheet(doc);

  doc.setProperties({
    title: `${project.name} — independent baseline verification`,
    subject: `Baseline verification screening, ${WINDOW[0]}-${WINDOW[1]}`,
    creator: "Phantom",
  });

  header(doc, s, project, result.audit, generated);
  verdict(doc, s, result);
  mapBlock(doc, s, mapImage, year);
  chart(doc, s, result.timeline, year);
  exposure(doc, s, result.audit);
  purchases(doc, s, purchaseRows(project));
  parties(doc, s, project, record);
  method(doc, s, result);
  footers(doc, project, generated);

  const name = reportFileName(project, generated);
  doc.save(name);
  return name;
}
