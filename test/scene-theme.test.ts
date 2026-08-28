import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EMPTY_LIBRARY } from "../src/assets.js";
import { getTheme, THEMES, themeRevision } from "../src/themes.js";
import { buildScene, getTemplate, TEMPLATES } from "../src/templates.js";
import { run as cliRun } from "../src/scene-cli.js";
import { resolveFace } from "../src/fonts.js";
import { renderScene } from "../src/scene-render.js";
import { getBrowser } from "../src/browser.js";
import { decodePng } from "./png.js";
import { loadScene, type SceneLayer } from "../src/scene.js";

// --- fixture -------------------------------------------------------------------

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>`;

let projectRoot: string;

beforeAll(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), "thumby-theme-"));
  await writeFile(path.join(projectRoot, "bg.svg"), SVG);
});

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

// --- helpers ----------------------------------------------------------------

const textLayer = (over: Record<string, unknown> = {}): SceneLayer =>
  ({
    id: "headline",
    type: "text",
    text: "Hello",
    font: "Anton",
    fontSize: 96,
    position: { x: 100, y: 100 },
    size: { width: 800, height: 200 },
    ...over,
  }) as SceneLayer;

const load = async (raw: unknown) =>
  loadScene(projectRoot, () => Promise.resolve(EMPTY_LIBRARY), raw);

// --- themes: registry and revision identity -----------------------------------

describe("scene themes", () => {
  it("fills unset layer properties from the pinned theme at load", async () => {
    const theme = getTheme("midnight");
    const scene = {
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      theme: { name: "midnight", revision: themeRevision(theme) },
      layers: [textLayer()],
    };
    const result = await load(scene);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const layer = result.resolved.scene.layers[0];
    expect((layer as { color?: string }).color).toEqual(theme.text!.color);
  });

  it("resolves themes as a pure transform — the caller's document is not mutated", async () => {
    const theme = getTheme("midnight");
    const scene = {
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      theme: { name: "midnight", revision: themeRevision(theme) },
      layers: [textLayer()],
    };
    const result = await load(scene);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The resolved scene is themed...
    expect((result.resolved.scene.layers[0] as { color?: string }).color).toBeDefined();
    // ...but the caller's object keeps exactly what was authored.
    expect((scene.layers[0] as { color?: string }).color).toBeUndefined();
  });

  it("lets explicit layer values win over theme defaults", async () => {
    const theme = getTheme("midnight");
    const scene = {
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      theme: { name: "midnight", revision: themeRevision(theme) },
      layers: [
        textLayer({ color: "#123456" }),
        textLayer({ id: "gradient", fill: { from: "#ffffff", to: "#000000" } }),
      ],
    };
    const result = await load(scene);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [solid, gradient] = result.resolved.scene.layers as { color?: string; fill?: unknown }[];
    expect(solid.color).toEqual("#123456");
    // The fill contract: an explicit fill wins the whole family — no theme
    // color sneaks in alongside it.
    expect(gradient.fill).toBeDefined();
    expect(gradient.color).toBeUndefined();
  });

  it("defaults image, shape, and group properties, recursing into group children", async () => {
    const theme = getTheme("midnight");
    const scene = {
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      theme: { name: "midnight", revision: themeRevision(theme) },
      layers: [
        {
          id: "card",
          type: "group",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 200 },
          layers: [
            {
              id: "plate-shape",
              type: "shape",
              shape: "rect",
              position: { x: 0, y: 0 },
              size: { width: 400, height: 200 },
            },
            textLayer({ id: "nested", font: "Anton", fontSize: 48 }),
          ],
        },
        {
          id: "photo",
          type: "image",
          asset: "./bg.svg",
          position: { x: 0, y: 0 },
          size: { width: 640, height: 360 },
        },
      ],
    };
    const result = await load(scene);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [card, photo] = result.resolved.scene.layers as unknown as [
      { layers: { color?: string }[] },
      { fit?: string },
    ];
    expect(card.layers[0].color).toEqual(theme.shape!.color);
    expect(card.layers[1].color).toEqual(theme.text!.color);
    expect(photo.fit).toEqual(theme.image!.fit);
  });

  it("locks the exact theme revision and rejects drift with actionable errors", async () => {
    const theme = getTheme("midnight");
    const scene = (over: Record<string, unknown>) => ({
      schemaVersion: 1,
      canvas: { width: 1280, height: 720 },
      theme: { name: "midnight", revision: themeRevision(theme), ...over },
      layers: [textLayer()],
    });
    // A prefix pin is enough — content identity is the hash.
    const prefix = await load(scene({ revision: themeRevision(theme).slice(0, 8) }));
    expect(prefix.ok).toBe(true);

    const drifted = await load(scene({ revision: "0".repeat(64) }));
    expect(drifted.ok).toBe(false);
    if (drifted.ok) return;
    const revError = drifted.errors.find((e) => e.path === "theme.revision");
    expect(revError?.message).toContain(themeRevision(theme));
    expect(revError?.message).toContain("re-pin");

    const unknown = await load(scene({ name: "nope" }));
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.errors.find((e) => e.path === "theme.name")?.message).toContain(
      "unknown theme",
    );
  });

  it("keeps every bundled theme schema-valid on bare layers of every type", async () => {
    for (const theme of THEMES) {
      const scene = {
        schemaVersion: 1,
        canvas: { width: 1280, height: 720 },
        theme: { name: theme.name, revision: themeRevision(theme) },
        layers: [
          textLayer(),
          {
            id: "bare-shape",
            type: "shape",
            shape: "ellipse",
            position: { x: 0, y: 0 },
            size: { width: 100, height: 100 },
          },
          {
            id: "bare-image",
            type: "image",
            asset: "./bg.svg",
            position: { x: 0, y: 0 },
            size: { width: 100, height: 100 },
          },
          {
            id: "bare-group",
            type: "group",
            position: { x: 0, y: 0 },
            size: { width: 100, height: 100 },
            layers: [
              {
                id: "bare-child",
                type: "shape",
                shape: "triangle",
                position: { x: 0, y: 0 },
                size: { width: 50, height: 50 },
              },
            ],
          },
        ],
      };
      const result = await load(scene);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [, ellipse] = result.resolved.scene.layers as [
        unknown,
        { radius?: number },
      ];
      // Radius is rect-only — a theme radius must never land on other geometries.
      expect(ellipse.radius).toBeUndefined();
    }
  });

  it("builds a valid Scene from a named template with the theme pin baked in", async () => {
    const scene = buildScene(getTemplate("headline-card"));
    expect(scene.schemaVersion).toEqual(1);
    const result = await load(scene);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (scene.theme) {
      const theme = getTheme(scene.theme.name);
      expect(scene.theme.revision).toEqual(themeRevision(theme));
    }
  });

  it("derives revision identity from rendering-relevant content only", () => {
    const theme = getTheme("midnight");
    // A docs-only description edit cannot change a render — it must not
    // invalidate pinned Scenes.
    expect(themeRevision({ ...theme, description: "rewritten" })).toEqual(
      themeRevision(theme),
    );
    // The hash is canonical (key-order independent), not insertion-order JSON.
    expect(themeRevision({ ...theme, shape: undefined, group: undefined })).toEqual(
      themeRevision({ ...theme, group: undefined, shape: undefined }),
    );
    // A content change does change the identity — drift is detectable.
    expect(themeRevision({ ...theme, shape: { ...theme.shape, color: "#000001" } })).not.toEqual(
      themeRevision(theme),
    );
    // A new defaults section joins the identity by construction — it can
    // never silently escape version locking.
    expect(themeRevision({ ...theme, video: { color: "#101010" } } as never)).not.toEqual(
      themeRevision(theme),
    );
  });

  it("initializes plain layers — theme values are not baked in beside the pin", async () => {
    const init = await cliRun(["init", "headline-card"]);
    expect(init.exitCode).toEqual(0);
    const scene = (init.output as { scene: { layers: Record<string, unknown>[]; theme: unknown } }).scene;
    // The theme pin is set...
    expect(scene.theme).toEqual({
      name: "midnight",
      revision: themeRevision(getTheme("midnight")),
    });
    // ...but the layers stay as authored — no theme-derived copies beside it.
    const scrim = scene.layers.find((l) => l.id === "scrim");
    expect(scrim).toBeDefined();
    expect(scrim!.color).toBeUndefined();
    for (const id of ["eyebrow", "headline"]) {
      const layer = scene.layers.find((l) => l.id === id);
      expect(layer).toBeDefined();
      expect(layer!.color).toBeUndefined();
      expect(layer!.shadows).toBeUndefined();
    }
  });

  it("keeps every bundled template loadable", async () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(2);
    for (const template of TEMPLATES) {
      const result = await load(buildScene(template));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Stable, unique ids — the agent's edit targets (DEC-006).
      const ids = result.resolved.scene.layers.map((l) => l.id);
      expect(new Set(ids).size).toEqual(ids.length);
    }
  });

  it("lists themes and templates as structured JSON", async () => {
    const themes = await cliRun(["themes"]);
    expect(themes.exitCode).toEqual(0);
    const themeList = (themes.output as { themes: { name: string; revision: string }[] }).themes;
    expect(themeList.map((t) => t.name)).toEqual(THEMES.map((t) => t.name));
    for (const t of themeList)
      expect(t.revision).toEqual(themeRevision(getTheme(t.name)));

    const templates = await cliRun(["templates"]);
    expect(templates.exitCode).toEqual(0);
    const templateList = (templates.output as { templates: { name: string }[] }).templates;
    expect(templateList.map((t) => t.name)).toEqual(TEMPLATES.map((t) => t.name));
  });

  it("initializes a valid Scene from a named template", async () => {
    const init = await cliRun(["init", "headline-card"]);
    expect(init.exitCode).toEqual(0);
    const scene = (init.output as { scene: unknown }).scene;
    const result = await load(scene);
    expect(result.ok).toBe(true);

    const unknown = await cliRun(["init", "nope"]);
    expect(unknown.exitCode).toEqual(2);
    expect(JSON.stringify(unknown.output)).toContain("unknown template");

    // --out writes only inside the current directory, and never clobbers
    // silently — same containment discipline as render --out.
    const prevCwd = process.cwd();
    const sandbox = await mkdtemp(path.join(prevCwd, ".init-test-"));
    try {
      process.chdir(sandbox);
      const out = await cliRun(["init", "stat-banner", "--out", "inited.json"]);
      expect(out.exitCode).toEqual(0);
      const written = JSON.parse(await readFile("inited.json", "utf8"));
      expect((await load(written)).ok).toBe(true);

      const clobber = await cliRun(["init", "stat-banner", "--out", "inited.json"]);
      expect(clobber.exitCode).toEqual(2);
      expect(JSON.stringify(clobber.output)).toContain("already exists");
      const forced = await cliRun(["init", "stat-banner", "--out", "inited.json", "--force"]);
      expect(forced.exitCode).toEqual(0);

      const escape = await cliRun(["init", "stat-banner", "--out", "../escaped.json"]);
      expect(escape.exitCode).toEqual(2);
      expect(JSON.stringify(escape.output)).toContain("must stay inside");
    } finally {
      process.chdir(prevCwd);
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("inspect shows the effective values a render will use", async () => {
    const sceneFile = path.join(projectRoot, "effective.json");
    await writeFile(
      sceneFile,
      JSON.stringify({
        schemaVersion: 1,
        canvas: { width: 1280, height: 720 },
        theme: {
          name: "midnight",
          revision: themeRevision(getTheme("midnight")),
        },
        layers: [
          {
            id: "photo",
            type: "image",
            asset: "./bg.svg",
            position: { x: 0, y: 0 },
            size: { width: 640, height: 360 },
          },
          textLayer({ id: "t" }),
          {
            id: "s",
            type: "shape",
            shape: "rect",
            position: { x: 0, y: 0 },
            size: { width: 100, height: 100 },
          },
        ],
      }),
    );
    const inspect = await cliRun(["inspect", sceneFile]);
    expect(inspect.exitCode).toEqual(0);
    const output = inspect.output as {
      theme?: { name: string; revision: string };
      layers: Record<string, unknown>[];
    };
    expect(output.theme?.name).toEqual("midnight");
    const [photo, text, shape] = output.layers;
    // Theme defaults surface as effective values...
    expect(photo.fit).toEqual("contain");
    expect(text.color).toEqual(getTheme("midnight").text!.color);
    expect(shape.color).toEqual(getTheme("midnight").shape!.color);
    // ...and so do the renderer's built-in defaults where no theme applies.
    expect(photo.opacity).toEqual(1);
    expect(photo.visible).toEqual(true);
    expect(text.align).toEqual("left");
    expect(text.lineHeight).toEqual(1.1);
    expect(text.weight).toEqual(resolveFace("Anton").weight);
    expect(shape.radius).toEqual(getTheme("midnight").shape!.radius);
  });

  it("renders theme-resolved values into the pixels", async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    await ctx.route("**/*", (route) => route.abort());
    const page = await ctx.newPage();
    try {
      const theme = getTheme("midnight");
      const resolved = await load({
        schemaVersion: 1,
        canvas: { width: 1280, height: 720 },
        theme: { name: "midnight", revision: themeRevision(theme) },
        layers: [
          {
            id: "backdrop",
            type: "shape",
            shape: "rect",
            position: { x: 0, y: 0 },
            size: { width: 1280, height: 720 },
          },
        ],
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const { png } = await renderScene(resolved.resolved, { page });
      const img = decodePng(png);
      const [r, g, b] = theme.shape!.color!.match(/#(\w{2})(\w{2})(\w{2})/)!.slice(1).map((h) => parseInt(h, 16));
      expect(img.px(640, 360)).toEqual([r, g, b, 255]);
    } finally {
      await page.context().close();
    }
  }, 20000);
});
