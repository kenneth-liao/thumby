/**
 * Bundled named themes — one home for theme content and its revision identity.
 *
 * A theme is a named set of style-property defaults per layer type. Themes
 * never default layout facts (id, position, size) or schema-required fields
 * (font, the fontSize/autoFit pair) — a Scene stays schema-valid standalone;
 * themes only fill properties the Scene leaves unset.
 *
 * Revision identity follows ADR-0002's shape for assets: the revision is the
 * sha-256 of the theme's rendering-relevant content (its defaults sections,
 * canonically serialized), derived never stored. A Scene pins the prefix;
 * src/scene.ts re-derives the hash at load and fails loudly on drift, so an
 * old Scene cannot silently render with new theme content. Names and
 * descriptions cannot change a render and are excluded from the identity.
 */
import { createHash } from "node:crypto";
import type { Effects, SceneLayer } from "./scene.js";

export interface ThemeTextDefaults {
  weight?: number;
  tracking?: number;
  casing?: "upper" | "lower" | "none";
  color?: string;
  fill?: { from: string; to: string; angle?: number };
  stroke?: { width: number; color: string };
  shadows?: { x: number; y: number; blur: number; color: string }[];
  align?: "left" | "center" | "right";
  lineHeight?: number;
}

export interface ThemeImageDefaults {
  fit?: "cover" | "contain" | "fill" | "none";
  effects?: Effects;
}

export interface ThemeShapeDefaults {
  color?: string;
  fill?: { from: string; to: string; angle?: number };
  border?: { width: number; color: string };
  radius?: number;
}

export interface ThemeGroupDefaults {
  scale?: number;
  effects?: Effects;
}

export interface Theme {
  name: string;
  description: string;
  text?: ThemeTextDefaults;
  image?: ThemeImageDefaults;
  shape?: ThemeShapeDefaults;
  group?: ThemeGroupDefaults;
}

export const THEMES: Theme[] = [
  {
    name: "midnight",
    description:
      "Dark-scene defaults: near-white text with a soft drop shadow and dark shape fills.",
    text: {
      color: "#f5f5f7",
      tracking: -0.01,
      shadows: [{ x: 0, y: 2, blur: 8, color: "#00000099" }],
    },
    image: { fit: "contain" },
    shape: { color: "#14161c", radius: 12 },
  },
  {
    name: "paper",
    description: "Light-scene defaults: near-black text and warm paper shape fills.",
    text: { color: "#17181c" },
    shape: { color: "#f4f1ea" },
  },
];

export function getTheme(name: string): Theme {
  const hit = THEMES.find((t) => t.name === name);
  if (!hit)
    throw new Error(
      `unknown theme "${name}" — bundled themes: ${THEMES.map((t) => t.name).join(", ")}`,
    );
  return hit;
}

/**
 * Deterministic serialization with sorted keys — canonical JSON, so
 * reordering a literal's keys never changes the derived revision.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * sha-256 of the theme's rendering-relevant content — its defaults sections,
 * canonically serialized. Descriptions and names are excluded: they cannot
 * change a render, so editing them must not invalidate pinned Scenes.
 */
export function themeRevision(theme: Theme): string {
  return createHash("sha256")
    .update(canonical({ text: theme.text, image: theme.image, shape: theme.shape, group: theme.group }))
    .digest("hex");
}

type FillFamily = { color?: string; fill?: { from: string; to: string; angle?: number } };

/**
 * The fill family rule, one form: a theme default applies only where the
 * layer sets neither member — an explicit color or fill always wins the
 * whole family.
 */
function applyFillFamily(layer: FillFamily, defaults: FillFamily): void {
  if (layer.color !== undefined || layer.fill !== undefined) return;
  if (defaults.color !== undefined) layer.color = defaults.color;
  else if (defaults.fill !== undefined) layer.fill = defaults.fill;
}

/** Apply one theme's defaults to a single layer, in place. Contract-aware. */
export function applyThemeToLayer(layer: SceneLayer, theme: Theme): void {
  // Themes are process-wide singletons; clone at assignment so a later
  // in-place layer edit can never mutate theme content (and its revision).
  if (theme.text && layer.type === "text") {
    const t: ThemeTextDefaults = structuredClone(theme.text);
    const rec = layer as unknown as Record<string, unknown>;
    for (const key of ["weight", "tracking", "casing", "align", "lineHeight", "stroke", "shadows"] as const)
      if (layer[key] === undefined && t[key] !== undefined) rec[key] = t[key];
    applyFillFamily(layer, t);
  }
  if (theme.shape && layer.type === "shape") {
    const t: ThemeShapeDefaults = structuredClone(theme.shape);
    if (layer.border === undefined && t.border !== undefined) layer.border = t.border;
    applyFillFamily(layer, t);
    // Radius is rect-only (semantic pass) — never land on other geometries.
    if (layer.shape === "rect" && layer.radius === undefined && t.radius !== undefined)
      layer.radius = t.radius;
  }
  if (theme.image && layer.type === "image") {
    const t = structuredClone(theme.image);
    if (layer.fit === undefined && t.fit !== undefined) layer.fit = t.fit;
    if (layer.effects === undefined && t.effects !== undefined) layer.effects = t.effects;
  }
  if (theme.group && layer.type === "group") {
    const t = structuredClone(theme.group);
    if (layer.scale === undefined && t.scale !== undefined) layer.scale = t.scale;
    if (layer.effects === undefined && t.effects !== undefined) layer.effects = t.effects;
  }
}
