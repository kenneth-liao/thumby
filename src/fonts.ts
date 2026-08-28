/**
 * Type pairings. Each is a display face for the headline plus a humanist sans
 * for the eyebrow and kicker. Every face is bundled under assets/fonts/ as an
 * OFL-licensed TTF (latin subset) and loaded via @font-face from local bytes —
 * no system fonts, no network. See assets/fonts/LICENSE.md.
 */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface FontFace {
  /** The family name the CSS and @font-face rule use. */
  family: string;
  /** The face's real weight — the @font-face declaration and the CSS font-weight use it. */
  weight: number;
  /** File name under assets/fonts/. */
  file: string;
}

export interface Pairing {
  display: FontFace;
  sans: FontFace;
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

const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");

const SOURCE_SANS = {
  family: "Source Sans 3",
  weight: 600,
  file: "source-sans-3.ttf",
};

export const PAIRINGS: Record<string, Pairing> = {
  // --- punchy display sans -------------------------------------------------
  condensed: {
    display: { family: "Anton", weight: 400, file: "anton.ttf" },
    sans: SOURCE_SANS,
    tracking: "-0.02em",
    textCase: "upper",
    strokeScale: 1.35,
    description: "Anton + Source Sans 3 — most caps per line, heaviest strokes",
  },
  impact: {
    display: { family: "Archivo Black", weight: 400, file: "archivo-black.ttf" },
    sans: SOURCE_SANS,
    tracking: "-0.01em",
    textCase: "upper",
    strokeScale: 1.35,
    description: "Archivo Black + Source Sans 3 — the canonical thumbnail face",
  },
  black: {
    display: { family: "Oswald", weight: 700, file: "oswald.ttf" },
    sans: SOURCE_SANS,
    tracking: "-0.02em",
    textCase: "upper",
    strokeScale: 1.35,
    description: "Oswald Bold + Source Sans 3 — tall condensed caps",
  },
  phosphate: {
    display: { family: "Passion One", weight: 900, file: "passion-one.ttf" },
    sans: SOURCE_SANS,
    tracking: "0",
    textCase: "upper",
    strokeScale: 1.2,
    description: "Passion One Black + Source Sans 3 — condensed with more character",
  },
  script: {
    display: { family: "Permanent Marker", weight: 400, file: "permanent-marker.ttf" },
    sans: SOURCE_SANS,
    tracking: "0.01em",
    textCase: "style",
    strokeScale: 0.5,
    description: "Permanent Marker + Source Sans 3 — hand-painted marker lettering",
  },

  // --- cartographic serif --------------------------------------------------
  clarendon: {
    display: { family: "Bevan", weight: 400, file: "bevan.ttf" },
    sans: SOURCE_SANS,
    tracking: "-0.008em",
    textCase: "style",
    strokeScale: 1,
    description: "Bevan + Source Sans 3 — park-sign slab, editorial",
  },
  iowan: {
    display: { family: "Lora", weight: 700, file: "lora.ttf" },
    sans: { family: "Nunito Sans", weight: 700, file: "nunito-sans.ttf" },
    tracking: "-0.005em",
    textCase: "style",
    strokeScale: 1,
    description: "Lora Bold + Nunito Sans Bold — warmer, bookish oldstyle",
  },
  hoefler: {
    display: { family: "Alegreya", weight: 900, file: "alegreya.ttf" },
    sans: { family: "Marcellus", weight: 400, file: "marcellus.ttf" },
    tracking: "0",
    textCase: "style",
    strokeScale: 1,
    description: "Alegreya Black + Marcellus — engraved and literary; thins out small",
  },
  charter: {
    display: { family: "Bitter", weight: 700, file: "bitter.ttf" },
    sans: { family: "Montserrat", weight: 600, file: "montserrat.ttf" },
    tracking: "-0.005em",
    textCase: "style",
    strokeScale: 1,
    description: "Bitter Bold + Montserrat — sturdy, modern, lowest contrast",
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

export function fontAssetPath(face: FontFace): string {
  return path.join(FONTS_DIR, face.file);
}

/** Reads the bundled bytes and throws naming the family when they are absent. */
export function readFontAsset(face: FontFace): { family: string; weight: number; dataUri: string } {
  const file = fontAssetPath(face);
  if (!existsSync(file)) {
    throw new Error(
      `Font "${face.family}" is not bundled: assets/fonts/${face.file} is missing`,
    );
  }
  const b64 = readFileSync(file).toString("base64");
  return {
    family: face.family,
    weight: face.weight,
    dataUri: `data:font/ttf;base64,${b64}`,
  };
}

/** @font-face rules for the given faces, each from its bundled bytes. */
export function fontFaceCss(...faces: FontFace[]): string {
  return faces
    .map((f) => {
      const { family, weight, dataUri } = readFontAsset(f);
      return `@font-face { font-family: "${family}"; font-weight: ${weight}; src: url(${dataUri}) format("truetype"); }`;
    })
    .join("\n");
}

/** Startup validation: every face of the pairing must be bundled. */
export function assertFontAssets(p: Pairing): void {
  for (const face of [p.display, p.sans]) {
    if (!existsSync(fontAssetPath(face))) {
      throw new Error(
        `Font "${face.family}" is not bundled: assets/fonts/${face.file} is missing`,
      );
    }
  }
}

/**
 * Browser-side family resolution probe, evaluated in the compositor page:
 * measures a proportional-glyph string with the requested family followed by
 * monospace in the font stack, then monospace alone; equal widths mean the
 * family fell through to monospace, i.e. it silently failed to resolve.
 * The family is force-loaded first so unused faces are not false negatives.
 */
export const familyResolvedJs = `(async (family) => {
  try { await document.fonts.load('32px "' + family + '"'); } catch { return false; }
  const probe = "mmmmwwwwmmmm";
  const el = document.createElement("span");
  el.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font-size:32px;";
  el.textContent = probe;
  document.body.appendChild(el);
  const width = (stack) => { el.style.fontFamily = stack; return el.getBoundingClientRect().width; };
  const withFamily = width('"' + family + '", monospace');
  const fallback = width("monospace");
  el.remove();
  return withFamily !== fallback;
})`;
