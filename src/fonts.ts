/**
 * Type pairings. Each is a display face for the headline plus a humanist sans
 * for the eyebrow and kicker. Every face ships with macOS, so Chromium
 * resolves them with no @font-face and no network.
 *
 * Weights are requested numerically; CoreText picks the nearest real face.
 */
export interface Pairing {
  display: string;
  displayWeight: number;
  sans: string;
  sansWeight: number;
  /** Headline tracking. Condensed blacks want a touch negative. */
  tracking: string;
  /**
   * "style" defers to the preset. Display sans faces are drawn for caps at
   * size, so they pin to upper regardless of which preset is running.
   */
  textCase: "upper" | "style";
  /** Multiplies the preset stroke. Sans takes a heavier outline than serif. */
  strokeScale: number;
  description: string;
}

const GILL = { sans: "Gill Sans", sansWeight: 600 };

export const PAIRINGS: Record<string, Pairing> = {
  // --- punchy display sans -------------------------------------------------
  condensed: {
    display: "HelveticaNeue-CondensedBlack",
    displayWeight: 900,
    ...GILL,
    tracking: "-0.02em",
    textCase: "upper",
    strokeScale: 1.35,
    description: "Helvetica Neue Condensed Black + Gill Sans — most caps per line, heaviest strokes",
  },
  impact: {
    display: "Impact",
    displayWeight: 400,
    ...GILL,
    tracking: "-0.01em",
    textCase: "upper",
    strokeScale: 1.35,
    description: "Impact + Gill Sans — the canonical thumbnail face",
  },
  black: {
    display: "Arial Black",
    displayWeight: 900,
    ...GILL,
    tracking: "-0.02em",
    textCase: "upper",
    strokeScale: 1.35,
    description: "Arial Black + Gill Sans — widest and boldest; fewer words per line",
  },
  phosphate: {
    display: "Phosphate",
    displayWeight: 400,
    ...GILL,
    tracking: "0",
    textCase: "upper",
    strokeScale: 1.2,
    description: "Phosphate Solid + Gill Sans — condensed with more character",
  },
  script: {
    display: "Brush Script MT",
    displayWeight: 400,
    ...GILL,
    tracking: "0.01em",
    textCase: "style",
    strokeScale: 0.5,
    description: "Brush Script MT + Gill Sans — hand-painted brush lettering",
  },

  // --- cartographic serif --------------------------------------------------
  clarendon: {
    display: "SuperClarendon",
    displayWeight: 900,
    ...GILL,
    tracking: "-0.008em",
    textCase: "style",
    strokeScale: 1,
    description: "Superclarendon Black + Gill Sans — park-sign slab, editorial",
  },
  iowan: {
    display: "Iowan Old Style",
    displayWeight: 900,
    sans: "Seravek",
    sansWeight: 700,
    tracking: "-0.005em",
    textCase: "style",
    strokeScale: 1,
    description: "Iowan Old Style Black + Seravek — warmer, bookish oldstyle",
  },
  hoefler: {
    display: "Hoefler Text",
    displayWeight: 900,
    sans: "Optima",
    sansWeight: 600,
    tracking: "0",
    textCase: "style",
    strokeScale: 1,
    description: "Hoefler Text Black + Optima — engraved and literary; thins out small",
  },
  charter: {
    display: "Charter",
    displayWeight: 700,
    sans: "Avenir Next",
    sansWeight: 600,
    tracking: "-0.005em",
    textCase: "style",
    strokeScale: 1,
    description: "Charter Bold + Avenir Next — sturdy, modern, lowest contrast",
  },
};

export const DEFAULT_PAIRING = "condensed";

export function resolvePairing(name: string): Pairing {
  const p = PAIRINGS[name];
  if (!p) {
    throw new Error(
      `Unknown --type "${name}". Options: ${Object.keys(PAIRINGS).join(", ")}`,
    );
  }
  return p;
}
