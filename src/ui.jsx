// ui.jsx — formatters and the small shared pieces of the interface.
import { useEffect, useRef, useState } from "react";

export const GRADE_COLORS = { A: "#2fbf71", B: "#9bcf3b", C: "#e8b931", D: "#ee7f2d", F: "#e5484d" };
export const GRADE_ORDER = ["A", "B", "C", "D", "F"];
export const CONF_COLORS = { high: "#2fbf71", medium: "#e8b931", low: "#e5484d" };

export const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
export const fmtMoney = (n) => "$" + fmtInt(n);
export const fmtCompact = (n) =>
  n >= 1e9 ? "$" + (n / 1e9).toFixed(2) + "B"
  : n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M"
  : n >= 1e3 ? "$" + Math.round(n / 1e3) + "K"
  : "$" + Math.round(n);
export const fmtPct = (x, d = 1) => (x * 100).toFixed(d) + "%";
export const fmtHa = (n) => (n >= 1000 ? fmtInt(n / 1000) + "k ha" : fmtInt(n) + " ha");

export function Grade({ g, size = "sm" }) {
  const c = GRADE_COLORS[g];
  return (
    <span className={`grade grade-${size}`} style={{ color: c, background: c + "1c", borderColor: c + "55" }}>
      {g}
    </span>
  );
}

export function Confidence({ level }) {
  return (
    <span className="conf" style={{ color: CONF_COLORS[level] }}>
      <i className="dot" style={{ background: CONF_COLORS[level] }} />
      {level}
    </span>
  );
}

export function useCountUp(target, ms = 1100) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf, t0;
    const step = (t) => {
      if (!t0) t0 = t;
      const k = Math.min((t - t0) / ms, 1);
      setV(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

/**
 * Forest cover inside the project against its counterfactual ring.
 * Drawn by hand so the crediting window and the years before it read as one
 * picture: the gap that opens after `windowStart` is the whole claim.
 */
export function LossCurve({ series, windowStart, grade, year, height = 132 }) {
  if (!series?.length) return null;
  const W = 320, H = height, L = 30, R = 8, T = 10, B = 18;
  const xs = series.map((d) => d.year);
  const vals = series.flatMap((d) => [d.project, d.ring]);
  const lo = Math.max(0, Math.floor(Math.min(...vals) / 5) * 5 - 2);
  const hi = Math.min(100, Math.ceil(Math.max(...vals) / 5) * 5 + 2);
  const x = (yr) => L + ((yr - xs[0]) / (xs.at(-1) - xs[0])) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const line = (k) => series.map((d, i) => `${i ? "L" : "M"}${x(d.year).toFixed(1)},${y(d[k]).toFixed(1)}`).join("");
  const band =
    series.map((d) => `${x(d.year).toFixed(1)},${y(d.ring).toFixed(1)}`).join("L") +
    "L" +
    [...series].reverse().map((d) => `${x(d.year).toFixed(1)},${y(d.project).toFixed(1)}`).join("L");
  const gc = GRADE_COLORS[grade] || "#4fa8d8";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {windowStart > xs[0] && (
        <>
          <rect x={x(windowStart)} y={T} width={W - R - x(windowStart)} height={H - T - B} fill="rgba(255,255,255,.035)" />
          <line x1={x(windowStart)} y1={T} x2={x(windowStart)} y2={H - B} stroke="#3a4750" strokeWidth="1" strokeDasharray="2 2" />
          <text x={x(windowStart) + 4} y={T + 9} fill="#5d6f7b" fontSize="8" fontFamily="ui-monospace, monospace">
            crediting window
          </text>
        </>
      )}
      {[lo, hi].map((v) => (
        <g key={v}>
          <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="#1e272e" strokeWidth="1" />
          <text x={L - 5} y={y(v) + 3} fill="#5d6f7b" fontSize="8.5" textAnchor="end" fontFamily="ui-monospace, monospace">
            {v}%
          </text>
        </g>
      ))}
      <path d={`M${band}Z`} fill={gc} opacity="0.14" />
      <path d={line("ring")} fill="none" stroke="#4fa8d8" strokeWidth="1.6" strokeDasharray="4 3" />
      <path d={line("project")} fill="none" stroke={gc} strokeWidth="2" />
      {year != null && year >= xs[0] && year <= xs.at(-1) && (
        <line x1={x(year)} y1={T} x2={x(year)} y2={H - B} stroke="#e7eef3" strokeWidth="1" opacity="0.55" />
      )}
      {[xs[0], windowStart, xs.at(-1)].filter((v, i, a) => v != null && a.indexOf(v) === i).map((yr) => (
        <text key={yr} x={x(yr)} y={H - 5} fill="#5d6f7b" fontSize="8.5" textAnchor="middle" fontFamily="ui-monospace, monospace">
          {yr}
        </text>
      ))}
    </svg>
  );
}

/** Split bar: supported vs unsupported spend. */
export function SplitBar({ supported, unsupported }) {
  const total = supported + unsupported || 1;
  return (
    <div className="bar-track">
      <i className="bar-fill" style={{ width: `${(supported / total) * 100}%`, background: "#2fbf71" }} />
      <i className="bar-fill" style={{ width: `${(unsupported / total) * 100}%`, background: "#e5484d" }} />
    </div>
  );
}

export function Toggle({ checked, onChange, label, note }) {
  return (
    <div className="row">
      <div>
        <div className="row-label">{label}</div>
        {note && <div className="row-note">{note}</div>}
      </div>
      <button role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />
    </div>
  );
}

/** Debounced-to-animation-frame callback, for scrubbing without jank. */
export function useRafCallback(fn) {
  const raf = useRef(0);
  const latest = useRef(fn);
  latest.current = fn;
  return (...args) => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => latest.current(...args));
  };
}
