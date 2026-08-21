/*
 * The review panel's own stylesheet, injected on quiz pages only. It is the
 * only one of the three that interpolates anything: the panel width and the
 * Item Info font scale are configuration, not CSS.
 */
import { ITEM_INFO_FONT_SCALE, PANEL_WIDTH, WK_FONT_SIZES } from '../config';

const scaled = (name: keyof typeof WK_FONT_SIZES) =>
  Math.round(WK_FONT_SIZES[name] * ITEM_INFO_FONT_SCALE);

export const CSS = `
:root { --wkrr-w: ${PANEL_WIDTH}; }
html.wkrr-collapsed { --wkrr-w: 0px; }

/* WaniKani's .quiz is position:fixed;width:100% - shrink it to free the right column */
.quiz { width: calc(100% - var(--wkrr-w)) !important; }

/* Item Info reads small at default size - scale WaniKani's own font-size scale. */
#subject-info, .subject-info {
  font-size: ${scaled('small')}px;
  --font-size-xxsmall: ${scaled('xxsmall')}px;
  --font-size-xsmall: ${scaled('xsmall')}px;
  --font-size-small: ${scaled('small')}px;
  --font-size-medium: ${scaled('medium')}px;
  --font-size-large: ${scaled('large')}px;
  --font-size-xlarge: ${scaled('xlarge')}px;
  --font-size-xxlarge: ${scaled('xxlarge')}px;
}

/*
 * Dark only - the panel is never shown light. Values match the bundled "WaniKani
 * Elementary Dark" palette and defer to its --USER-* variables where a Stylus
 * install defines them, so the panel reads as one system with the theme and
 * inherits any user colour customisation.
 */
#wkrr-panel {
  --wkrr-bg: var(--USER-surface-1, #151515);
  --wkrr-card: var(--USER-surface-2, #282828);
  --wkrr-raised: var(--USER-surface-3, #303030);
  --wkrr-border: var(--USER-surface-4, #535353);
  --wkrr-fg: var(--USER-text, #eeeeee);
  --wkrr-muted: var(--USER-text-grayed, #bbbbbb);
  --wkrr-faint: color-mix(in srgb, var(--USER-text-grayed, #bbbbbb), transparent 40%);
  --wkrr-bad: color-mix(in srgb, var(--USER-incorrect, #9c4644), white 25%);
  --wkrr-bad-bg: color-mix(in srgb, var(--USER-incorrect, #9c4644), transparent 78%);
  --wkrr-on-accent: var(--USER-text, #eeeeee);

  position: fixed; top: 0; right: 0; bottom: 0;
  width: var(--wkrr-w);
  display: flex; flex-direction: column;
  background: var(--wkrr-bg); color: var(--wkrr-fg);
  border-left: 1px solid var(--wkrr-border);
  font-family: var(--font-family-default, "Noto Sans", Helvetica, Arial, sans-serif);
  font-size: 13px; line-height: 1.45;
  z-index: 100; overflow: hidden;
  box-sizing: border-box;
}
#wkrr-panel *, #wkrr-panel *::before, #wkrr-panel *::after { box-sizing: border-box; }

html.wkrr-collapsed #wkrr-panel {
  width: auto; background: none; border: 0; overflow: visible;
  top: 50%; bottom: auto; transform: translateY(-50%);
}
.wkrr-reopen {
  display: flex; align-items: center; gap: 6px;
  writing-mode: vertical-rl;
  padding: 14px 6px; border: 0; cursor: pointer;
  background: var(--color-kanji, #f100a1); color: var(--wkrr-on-accent);
  border-radius: 6px 0 0 6px;
  font: inherit; font-weight: 700; letter-spacing: .04em;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
}
.wkrr-reopen__count {
  background: rgba(255,255,255,.28); border-radius: 8px; padding: 3px 5px; font-size: 11px;
}

.wkrr-header {
  padding: 10px 12px; background: var(--wkrr-raised);
  border-bottom: 1px solid var(--wkrr-border); flex: none;
}
.wkrr-header__top { display: flex; align-items: center; justify-content: space-between; }
.wkrr-header__title { font-weight: 700; font-size: 14px; letter-spacing: .02em; }
.wkrr-icon-btn {
  border: 0; background: none; cursor: pointer; color: var(--wkrr-muted);
  font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 4px;
}
.wkrr-icon-btn:hover { background: var(--wkrr-border); color: var(--wkrr-fg); }

.wkrr-stats { display: flex; gap: 12px; margin-top: 4px; color: var(--wkrr-muted); font-size: 12px; }
.wkrr-stat b { color: var(--wkrr-fg); font-size: 13px; }

.wkrr-toolbar { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
.wkrr-toolbar__spacer { flex: 1; }
.wkrr-tab {
  border: 1px solid var(--wkrr-border); background: transparent; color: var(--wkrr-muted);
  border-radius: 999px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px;
}
.wkrr-tab:hover { color: var(--wkrr-fg); }
.wkrr-tab.is-active {
  background: var(--wkrr-fg); border-color: var(--wkrr-fg); color: var(--wkrr-bg);
}
.wkrr-text-btn {
  border: 0; background: none; color: var(--wkrr-muted); cursor: pointer;
  font: inherit; font-size: 12px; padding: 3px 5px; border-radius: 4px;
}
.wkrr-text-btn:hover { background: var(--wkrr-border); color: var(--wkrr-fg); }

.wkrr-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 8px; }

.wkrr-section + .wkrr-section { margin-top: 12px; }
.wkrr-section__head {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 4px; border: 0; background: none; cursor: pointer;
  border-radius: 4px; font: inherit; text-align: left;
}
.wkrr-section__head:hover { background: var(--wkrr-card); }
.wkrr-section__chevron {
  color: var(--wkrr-faint); font-size: 10px; line-height: 1;
  transition: transform .15s ease;
}
.wkrr-section.is-collapsed .wkrr-section__chevron { transform: rotate(-90deg); }
.wkrr-section__title {
  flex: 1; font-weight: 700; font-size: 12px;
  text-transform: uppercase; letter-spacing: .06em; color: var(--wkrr-muted);
}
.wkrr-section__count {
  background: var(--wkrr-border); color: var(--wkrr-fg); border-radius: 999px;
  padding: 1px 7px; font-size: 11px; font-weight: 700;
}
.wkrr-section__hint { padding: 0 4px 6px; color: var(--wkrr-faint); font-size: 11px; }

.wkrr-card {
  background: var(--wkrr-card); border: 1px solid var(--wkrr-border);
  border-left: 4px solid var(--wkrr-accent);
  border-radius: 5px; margin-bottom: 8px; overflow: hidden;
}
.wkrr-card.is-resolved { opacity: .7; }
.wkrr-card.is-resolved:hover { opacity: 1; }
.wkrr-card__head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 10px; background: var(--wkrr-accent); color: var(--wkrr-on-accent);
}
.wkrr-card__link { color: inherit; text-decoration: none; display: inline-flex; align-items: center; }
.wkrr-card__link:hover { text-decoration: underline; }
.wkrr-card__chars { font-size: 24px; line-height: 1.15; font-weight: 500; }
.wkrr-card__image { height: 26px; width: auto; filter: brightness(0) invert(1); }
.wkrr-card__badges { display: flex; align-items: center; gap: 4px; flex: none; }
.wkrr-card__type { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: .8; }
.wkrr-card__count {
  background: rgba(0,0,0,.25); border-radius: 999px; padding: 1px 6px;
  font-size: 11px; font-weight: 700; white-space: nowrap;
}

/* Unlabelled value rows: English = meaning, Japanese = reading, red = you typed. */
.wkrr-card__body { padding: 6px 10px 8px; }
.wkrr-line {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px;
  padding: 2px 0; word-wrap: break-word;
}
.wkrr-meaning { font-weight: 600; font-size: 17px; }
.wkrr-meaning-alt { color: var(--wkrr-muted); font-size: 14px; }
.wkrr-readings { font-size: 21px; }
.wkrr-reading.is-primary { font-weight: 700; }
.wkrr-tag {
  color: var(--wkrr-faint); font-size: 10px; letter-spacing: .06em;
  text-transform: uppercase; border: 1px solid var(--wkrr-border);
  border-radius: 3px; padding: 0 4px; line-height: 1.5;
}

.wkrr-chips { gap: 4px; margin-top: 2px; }
.wkrr-chip {
  background: var(--wkrr-bad-bg); color: var(--wkrr-bad);
  border: 1px solid color-mix(in srgb, var(--wkrr-bad), transparent 55%);
  border-radius: 4px; padding: 1px 6px; font-size: 14px;
  text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--wkrr-bad), transparent 45%);
}
.wkrr-chip--reading { font-size: 16px; }

.wkrr-empty { text-align: center; color: var(--wkrr-muted); padding: 34px 14px; }
.wkrr-empty__mark { font-size: 26px; color: var(--wkrr-faint); margin-bottom: 6px; }
.wkrr-empty__sub { font-size: 11px; margin-top: 3px; color: var(--wkrr-faint); }

/* Below ~900px an 80/20 split is unusable - keep the panel out of the way. */
@media (max-width: 900px) {
  :root { --wkrr-w: 0px; }
  #wkrr-panel {
    width: auto; background: none; border: 0; overflow: visible;
    top: 50%; bottom: auto; transform: translateY(-50%);
  }
  #wkrr-panel .wkrr-header, #wkrr-panel .wkrr-body { display: none; }
}

/*
 * Current-level marker, directly under the character being quizzed. It only
 * renders for current-level items, so its presence is the highlight - hence the
 * solid pill rather than something that blends into the header.
 */
#wkrr-level {
  margin: 8px auto 0; width: max-content;
  padding: 3px 12px; border-radius: 999px;
  font-family: var(--font-family-default, "Noto Sans", Helvetica, Arial, sans-serif);
  font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
  color: var(--USER-text, #ffffff);
  background: rgba(0, 0, 0, .32);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .5);
  text-shadow: none;
}

/* Shift-to-peek popover. Dark only, matching the panel's palette. */
#wkrr-peek {
  --wkrr-bg: var(--USER-surface-1, #151515);
  --wkrr-card: var(--USER-surface-2, #282828);
  --wkrr-border: var(--USER-surface-4, #535353);
  --wkrr-fg: var(--USER-text, #eeeeee);
  --wkrr-muted: var(--USER-text-grayed, #bbbbbb);
  --wkrr-faint: color-mix(in srgb, var(--USER-text-grayed, #bbbbbb), transparent 40%);
  --wkrr-on-accent: var(--USER-text, #eeeeee);

  position: fixed; left: 50%; top: 14%; transform: translateX(-50%);
  z-index: 10000; display: none;
  width: max-content; max-width: min(440px, 92vw);
  background: var(--wkrr-card); color: var(--wkrr-fg);
  border: 1px solid var(--wkrr-border); border-radius: 10px;
  box-shadow: 0 12px 44px rgba(0,0,0,.35);
  font-family: var(--font-family-default, "Noto Sans", Helvetica, Arial, sans-serif);
  overflow: hidden;
}
#wkrr-peek.is-visible { display: block; }
#wkrr-peek *, #wkrr-peek *::before, #wkrr-peek *::after { box-sizing: border-box; }

.wkrr-peek__head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; background: var(--wkrr-accent); color: var(--wkrr-on-accent);
}
.wkrr-peek__chars { font-size: 34px; line-height: 1.1; font-weight: 500; }
.wkrr-peek__image { height: 34px; width: auto; filter: brightness(0) invert(1); }
.wkrr-peek__type {
  font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .85;
}
.wkrr-peek__body { padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; }
.wkrr-peek__row {
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px 8px; border-radius: 6px;
}
.wkrr-peek__row.is-asked {
  background: var(--wkrr-bg); box-shadow: inset 0 0 0 1px var(--wkrr-border);
}
.wkrr-peek__label {
  font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--wkrr-muted);
}
.wkrr-peek__hint {
  padding: 8px 16px 12px; color: var(--wkrr-faint); font-size: 11px;
}
/* Shown in place of the answer when revealing it would hand the item a burn. */
.wkrr-peek__blocked { padding: 12px 16px 2px; display: flex; flex-direction: column; gap: 5px; }
.wkrr-peek__blocked-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--color-srs-progress-enlightened, #0093dd);
}
.wkrr-peek__blocked-text { font-size: 13px; line-height: 1.45; color: var(--wkrr-muted); }
`;
