/*
 * The overall-progress widget, injected on the dashboard rather than the
 * review, so it is styled off WaniKani's widget and SRS variables instead of
 * the panel's palette - that way it looks native on stock WaniKani and picks
 * up Elementary Dark's colours when ./dark-theme.css is active. The fallbacks
 * are WaniKani's classic SRS palette, for when neither defines them.
 */
export const PROGRESS_CSS = `
.wkrr-progress {
  display: flex; flex-direction: column; gap: 7px;
  padding: var(--spacing-tight, 12px) var(--spacing-normal, 16px);
  background-color: var(--color-widget-background, #ffffff);
  border: 1px solid var(--color-widget-border, #cad0d6);
  border-radius: var(--border-radius-widget, 16px);
  color: var(--color-widget-primary-text, #333333);
  font-family: var(--font-family-default, "Noto Sans", Helvetica, Arial, sans-serif);
  font-size: 13px;
  box-sizing: border-box;
}
.wkrr-progress *, .wkrr-progress *::before, .wkrr-progress *::after { box-sizing: border-box; }

.wkrr-progress__head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
}
.wkrr-progress__title { font-weight: var(--font-weight-heavy, 700); }
/* Swapped for the hovered segment's numbers, so it must not resize the row. */
.wkrr-progress__readout {
  min-height: 1.4em; text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--color-widget-secondary-text, #6b7079);
}

/* Fills from the left: burned first, and the locked share is the empty tail. */
.wkrr-progress__bar {
  display: flex; gap: 2px; height: 18px;
  border-radius: 999px; overflow: hidden;
  background: color-mix(in srgb, var(--color-locked, #cccccc), transparent 55%);
  box-shadow: inset 0 0 0 1px var(--color-widget-border, #cad0d6);
}
/* A stage can be a handful of items out of thousands - keep it from vanishing. */
.wkrr-progress__segment { flex-basis: 0; min-width: 3px; }
/* The tail is the bare track, so it needs no minimum of its own. */
.wkrr-progress__segment--locked { min-width: 0; }
/* Not started: striped rather than tinted, which also parts it from Apprentice. */
.wkrr-progress__segment--lessons, .wkrr-progress__swatch--lessons {
  background-image: repeating-linear-gradient(
    135deg, rgba(255, 255, 255, .3) 0 3px, rgba(0, 0, 0, 0) 3px 6px
  );
}
/* Dim the rest while pointing at one, so the readout has an obvious subject. */
.wkrr-progress__bar:hover .wkrr-progress__segment,
.wkrr-progress__bar--pointed .wkrr-progress__segment { opacity: .4; }
.wkrr-progress__bar .wkrr-progress__segment:hover,
.wkrr-progress__bar .wkrr-progress__segment--lit { opacity: 1; }

/*
 * The counts, one entry per segment. It wraps rather than scrolls, so a narrow
 * dashboard column costs a second line instead of hiding half the stages.
 */
.wkrr-progress__legend {
  display: flex; flex-wrap: wrap; gap: 4px 16px;
  font-size: 12px; line-height: 1.4;
}
.wkrr-progress__key { display: flex; align-items: center; gap: 6px; }
.wkrr-progress__swatch {
  width: 10px; height: 10px; border-radius: 3px; flex: none;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .2);
}
/* Locked has no fill in the bar either - an outline says "not reached yet". */
.wkrr-progress__swatch--locked {
  box-shadow: inset 0 0 0 1px var(--color-widget-secondary-text, #6b7079);
}
.wkrr-progress__key-label { color: var(--color-widget-secondary-text, #6b7079); }
.wkrr-progress__key-count {
  font-weight: var(--font-weight-heavy, 700);
  font-variant-numeric: tabular-nums;
}
.wkrr-progress__key:hover .wkrr-progress__key-label { color: inherit; }
`;
