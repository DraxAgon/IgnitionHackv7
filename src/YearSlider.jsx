// YearSlider.jsx — the control that makes the evidence legible.
//
// The year is not a decoration on this map, it is the argument: forest loss is
// only visible as a sequence. So the slider has to be quick to scrub, obvious to
// read at a glance, and honest about which year of imagery is actually under the
// cursor — the loss polygons are annual, but the satellite mosaics are not
// published for every year, and pretending otherwise would be the one lie the
// map could tell without anyone noticing.

import { useCallback, useEffect, useRef } from "react";

const PLAY_MS = 900;

/**
 * @param {number}   year        currently displayed year
 * @param {number[]} years       every year in the analysis window
 * @param {boolean}  playing
 * @param {string}   imageryNote label for the imagery actually on screen
 */
export default function YearSlider({ year, years, onChange, playing, onPlayToggle, imageryNote }) {
  const trackRef = useRef(null);
  const dragging = useRef(false);

  const first = years[0];
  const last = years[years.length - 1];
  const step = useCallback((delta) => {
    const next = Math.min(last, Math.max(first, year + delta));
    if (next !== year) onChange(next);
  }, [year, first, last, onChange]);

  // Auto-advance. Looping back to the start rather than stopping at the end
  // means the sequence can be left running behind a conversation.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      onChange((prev) => (prev >= last ? first : prev + 1));
    }, PLAY_MS);
    return () => clearInterval(id);
  }, [playing, first, last, onChange]);

  // Scrubbing: pointer capture so a drag that leaves the bar keeps working.
  const yearAt = useCallback(
    (clientX) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return year;
      const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return first + Math.round(t * (last - first));
    },
    [first, last, year]
  );

  useEffect(() => {
    const move = (e) => {
      if (!dragging.current) return;
      const next = yearAt(e.clientX);
      if (next !== year) onChange(next);
    };
    const up = () => (dragging.current = false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [yearAt, year, onChange]);

  return (
    <div className="years panel">
      <button
        className="year-play"
        onClick={onPlayToggle}
        aria-label={playing ? "Pause" : "Play through the years"}
        aria-pressed={playing}
      >
        {playing ? (
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <rect x="2" y="1.5" width="3" height="9" rx="0.6" fill="currentColor" />
            <rect x="7" y="1.5" width="3" height="9" rx="0.6" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <path d="M3 1.6 L10.2 6 L3 10.4 Z" fill="currentColor" />
          </svg>
        )}
      </button>

      <span className="year-now" aria-live="polite">{year}</span>

      <div
        ref={trackRef}
        className="year-track"
        role="slider"
        tabIndex={0}
        aria-label="Year"
        aria-valuemin={first}
        aria-valuemax={last}
        aria-valuenow={year}
        aria-valuetext={String(year)}
        onPointerDown={(e) => {
          dragging.current = true;
          const next = yearAt(e.clientX);
          if (next !== year) onChange(next);
        }}
        onKeyDown={(e) => {
          const by = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 }[e.key];
          if (by) { e.preventDefault(); step(by); return; }
          if (e.key === "Home") { e.preventDefault(); onChange(first); }
          if (e.key === "End") { e.preventDefault(); onChange(last); }
          if (e.key === " " || e.key === "Enter") { e.preventDefault(); onPlayToggle(); }
        }}
      >
        {years.map((y) => (
          <button
            key={y}
            type="button"
            className={"year-tick" + (y === year ? " is-on" : "") + (y < year ? " is-past" : "")}
            aria-label={String(y)}
            aria-pressed={y === year}
            tabIndex={-1}
            onPointerDown={(e) => { e.stopPropagation(); onChange(y); }}
          >
            <span>{String(y).slice(2)}</span>
          </button>
        ))}
      </div>

      <span className="year-src" title="Imagery on screen right now">{imageryNote}</span>
    </div>
  );
}
