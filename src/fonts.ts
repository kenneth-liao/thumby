/**
 * Fonts bundled under assets/fonts/ as OFL-licensed TTFs (latin subsets).
 * Scene text loads them through @font-face from local bytes: no system fonts,
 * no network, and no silent fallback. See assets/fonts/LICENSE.md.
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

const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");

/**
 * Every bundled face keyed by family — the single home of font facts. Scene
 * text layers can only name fonts whose bytes the renderer ships.
 */
export const BUNDLED_FACES: ReadonlyMap<string, FontFace> = new Map(
  [
    { family: "Source Sans 3", weight: 600, file: "source-sans-3.ttf" },
    { family: "Anton", weight: 400, file: "anton.ttf" },
    { family: "Archivo Black", weight: 400, file: "archivo-black.ttf" },
    { family: "Oswald", weight: 700, file: "oswald.ttf" },
    { family: "Passion One", weight: 900, file: "passion-one.ttf" },
    { family: "Permanent Marker", weight: 400, file: "permanent-marker.ttf" },
    { family: "Bevan", weight: 400, file: "bevan.ttf" },
    { family: "Lora", weight: 700, file: "lora.ttf" },
    { family: "Nunito Sans", weight: 700, file: "nunito-sans.ttf" },
    { family: "Alegreya", weight: 900, file: "alegreya.ttf" },
    { family: "Marcellus", weight: 400, file: "marcellus.ttf" },
    { family: "Bitter", weight: 700, file: "bitter.ttf" },
    { family: "Montserrat", weight: 600, file: "montserrat.ttf" },
  ].map((face) => [face.family, face]),
);

/**
 * Resolve a text layer's font family to its bundled face. Throws naming the
 * available families when nothing matches, so a Scene never falls back silently.
 */
export function resolveFace(family: string): FontFace {
  const hit = BUNDLED_FACES.get(family);
  if (hit) return hit;
  throw new Error(
    `unknown font family "${family}" — bundled families: ${[...BUNDLED_FACES.keys()].join(", ")}`,
  );
}

export function fontAssetPath(face: FontFace): string {
  return path.join(FONTS_DIR, face.file);
}

/**
 * Single gate for bundled bytes: throws the one canonical message naming the
 * family when its file is absent. Returns the resolved file path.
 */
function requireFontAsset(face: FontFace): string {
  const file = fontAssetPath(face);
  if (!existsSync(file)) {
    throw new Error(
      `Font "${face.family}" is not bundled: assets/fonts/${face.file} is missing`,
    );
  }
  return file;
}

// data: URIs are pure per file — encode once, reuse across a batch sweep.
const dataUriCache = new Map<string, string>();

function fontDataUri(face: FontFace): string {
  const file = requireFontAsset(face);
  let uri = dataUriCache.get(file);
  if (!uri) {
    uri = `data:font/ttf;base64,${readFileSync(file).toString("base64")}`;
    dataUriCache.set(file, uri);
  }
  return uri;
}

/** Reads the bundled bytes and throws naming the family when they are absent. */
export function readFontAsset(face: FontFace): { family: string; weight: number; dataUri: string } {
  return {
    family: face.family,
    weight: face.weight,
    dataUri: fontDataUri(face),
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

/**
 * Browser-side family resolution probe, evaluated in the compositor page:
 * measures a proportional-glyph string with the requested family followed by
 * monospace in the font stack, then monospace alone; equal widths mean the
 * family fell through to monospace, i.e. it silently failed to resolve.
 * The family is force-loaded first so unused faces are not false negatives.
 * Must stay self-contained — Playwright serializes it into the page.
 */
export const familyResolved = async (family: string): Promise<boolean> => {
  try {
    await document.fonts.load(`32px "${family}"`);
  } catch {
    return false;
  }
  const probe = "mmmmwwwwmmmm";
  const el = document.createElement("span");
  el.style.cssText =
    "position:absolute;visibility:hidden;white-space:nowrap;font-size:32px;";
  el.textContent = probe;
  document.body.appendChild(el);
  const width = (stack: string) => {
    el.style.fontFamily = stack;
    return el.getBoundingClientRect().width;
  };
  const withFamily = width(`"${family}", monospace`);
  const fallback = width("monospace");
  el.remove();
  return withFamily !== fallback;
};
