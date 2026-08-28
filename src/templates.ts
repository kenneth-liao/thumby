/**
 * Bundled named templates — ready-made Scene skeletons an agent initializes
 * from and then edits as ordinary layers.
 *
 * A template bakes into a Scene at init (buildScene): the emitted layers are
 * plain Scene layers with stable ids (DEC-006), no runtime template reference
 * remains, so later template edits cannot drift an old Scene — immutability
 * by construction. A template may name a theme; buildScene pins it to that
 * theme's current revision, and the load gate (src/scene.ts) re-derives the
 * hash on every load.
 *
 * Templates carry no asset references — a freshly initialized Scene is valid
 * offline; the agent adds image layers with real assets afterwards.
 */
import type { Scene, SceneLayer } from "./scene.js";
import { getTheme, themeRevision } from "./themes.js";

export interface Template {
  name: string;
  description: string;
  canvas: { width: number; height: number };
  layers: SceneLayer[];
  /** Named theme whose current revision gets pinned into the built Scene. */
  themeName?: string;
}

const textLayer = (
  over: Record<string, unknown> & {
    id: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
  },
): SceneLayer =>
  ({
    type: "text",
    font: "Anton",
    fontSize: 96,
    align: "center",
    ...over,
  }) as SceneLayer;

export const TEMPLATES: Template[] = [
  {
    name: "blank",
    description: "Empty canvas — start from nothing, add layers yourself.",
    canvas: { width: 1280, height: 720 },
    layers: [],
  },
  {
    name: "headline-card",
    description:
      "A dark scrim band with eyebrow and headline text over the canvas bottom — drop a plate image underneath.",
    canvas: { width: 1280, height: 720 },
    themeName: "midnight",
    layers: [
      {
        id: "scrim",
        type: "shape",
        shape: "rect",
        radius: 0,
        position: { x: 80, y: 480 },
        size: { width: 1120, height: 180 },
      },
      textLayer({
        id: "eyebrow",
        text: "Eyebrow",
        font: "Montserrat",
        fontSize: 28,
        tracking: 0.08,
        casing: "upper",
        position: { x: 120, y: 505 },
        size: { width: 1040, height: 40 },
      }),
      textLayer({
        id: "headline",
        text: "Headline",
        fontSize: 84,
        position: { x: 120, y: 550 },
        size: { width: 1040, height: 100 },
      }),
    ],
  },
  {
    name: "stat-banner",
    description:
      "An accent bar with a big value and a small label — for a key number or callout.",
    canvas: { width: 1280, height: 720 },
    themeName: "midnight",
    layers: [
      {
        id: "accent-bar",
        type: "shape",
        shape: "rect",
        radius: 6,
        position: { x: 100, y: 520 },
        size: { width: 8, height: 140 },
      },
      textLayer({
        id: "stat-value",
        text: "10x",
        fontSize: 96,
        align: "left",
        position: { x: 132, y: 520 },
        size: { width: 600, height: 110 },
      }),
      textLayer({
        id: "stat-label",
        text: "Label",
        font: "Montserrat",
        fontSize: 32,
        align: "left",
        tracking: 0.06,
        casing: "upper",
        position: { x: 132, y: 630 },
        size: { width: 600, height: 40 },
      }),
    ],
  },
];

export function getTemplate(name: string): Template {
  const hit = TEMPLATES.find((t) => t.name === name);
  if (!hit)
    throw new Error(
      `unknown template "${name}" — bundled templates: ${TEMPLATES.map((t) => t.name).join(", ")}`,
    );
  return hit;
}

/** Bake one template into a complete Scene document, pinning its theme. */
export function buildScene(template: Template): Scene {
  return {
    schemaVersion: 1,
    canvas: template.canvas,
    ...(template.themeName
      ? {
          theme: {
            name: template.themeName,
            revision: themeRevision(getTheme(template.themeName)),
          },
        }
      : {}),
    layers: structuredClone(template.layers),
  };
}
