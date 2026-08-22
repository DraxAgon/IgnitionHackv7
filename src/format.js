// format.js — the number formats the panel and the exported report share.
//
// The point of the PDF is that a buyer can check it against the screen it came
// from. That stops being true the moment 32.55% rounds to 32.6% in one and
// 32.5% in the other, so both read their formatting from here.

export const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";

export const pts = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + " pts";

/** Abbreviated, for figures read at a glance. */
export const compact = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(Math.round(n));

export const money = (n) =>
  "$" + (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : Math.round(n));

/** Grouped in full, for figures that are the thing itself rather than a summary. */
export const full = (n) => Math.round(n).toLocaleString("en-US");

export const fullMoney = (n) => "$" + full(n);

/**
 * An overstatement multiple: how many times larger the claim is than the
 * benefit the satellite record supports. Rendered "23×" rather than "23.0×"
 * once it is large enough that the decimal is noise, and never rendered at all
 * when there is no measurable benefit to divide by — `null` is the caller's
 * signal to say so in words instead of printing an infinity.
 */
export const multiple = (v) =>
  v == null || !Number.isFinite(v) ? null : (v >= 10 ? Math.round(v) : v.toFixed(1)) + "×";

/** A share as a whole percentage, for figures read as a proportion of a claim. */
export const share = (v) => (v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0) + "%";
