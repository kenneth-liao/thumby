#!/usr/bin/env bun
/**
 * The Scene CLI — the agent-facing interface to Scene v1.
 *
 * Every command prints machine-readable JSON on stdout and signals the
 * outcome through its exit code:
 *   0 — the operation succeeded
 *   1 — the Scene failed validation, or rendering failed
 *   2 — usage error
 *
 * run() is the error boundary: unexpected failures (a crashed render, I/O
 * errors, a corrupt library) land in the same structured shape — nothing
 * escapes as a raw stack trace.
 *
 * All operations are offline and local: loading, validating, inspecting, and
 * rendering never touch the network and never start a Generation Job.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIBRARY_ROOT, scanLibrary, type ResolvedAsset } from "./assets.js";
import { SCENE_SCHEMA, LAYER_DEFAULTS, loadScene, SCHEMA_VERSION, type SceneError } from "./scene.js";
import { resolveFace } from "./fonts.js";
import { renderScene, countLayers } from "./scene-render.js";
import { THEMES, themeRevision } from "./themes.js";
import { buildScene, getTemplate, TEMPLATES } from "./templates.js";
import { closeBrowser } from "./browser.js";

const HELP = `
thumby scene — versioned, locally rendered thumbnail compositions

  bun run scene schema                  Print the Scene JSON Schema document
  bun run scene themes                  List bundled themes (name, description, revision)
  bun run scene templates               List bundled scene templates
  bun run scene init     <template>     Initialize a Scene from a template
  bun run scene inspect  <scene.json>   Structured layer summary (resolved asset hashes,
                                        theme-pinned identity, effective values)
  bun run scene validate <scene.json>   Validate: field-specific errors before any render
  bun run scene render   <scene.json>   Render to PNG (1280×720)

Options
  --out <path>   init: where to write the Scene (default: print as "scene")
                 render: output path inside the scene's directory
                 (default: <scene-dir>/out/<scene-basename>.png)

Themes and templates
  A Scene may pin a bundled theme: "theme": { "name", "revision" }. Precedence
  is one rule — explicit layer value, then theme default, then the renderer's
  built-in default. The revision is the sha-256 of the theme's content;
  loading re-derives it and fails loudly on drift, so old Scenes never render
  with silently changed theme content. "scene init" bakes a template's layers
  into a plain Scene (no runtime template reference) with the theme pin set.

Output is JSON on stdout: { "ok": true, ... } or { "ok": false, "errors": [...] }.
Successful renders carry a "warnings" array (e.g. an auto-fit layer that
could not fit at its min floor). Exit codes: 0 ok, 1 invalid scene or render
failure, 2 usage error.
Rendering, validation, and inspection are offline and never start generation.
`;

interface CliResult {
  exitCode: 0 | 1 | 2;
  output: unknown;
}

const ok = (output: unknown): CliResult => ({ exitCode: 0, output });
const usageError = (message: string): CliResult => ({
  exitCode: 2,
  output: { ok: false, errors: [{ path: "argv", message: `${message}\n\n${HELP.trim()}` }] },
});
const invalid = (errors: SceneError[]): CliResult => ({
  exitCode: 1,
  output: { ok: false, errors },
});

/** Read and parse a scene file. Parse failures are structured errors too. */
async function readSceneFile(
  file: string,
): Promise<{ raw: unknown } | { errors: SceneError[] }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return {
      errors: [{ path: file, message: `cannot read scene file: ${(err as Error).message}` }],
    };
  }
  try {
    return { raw: JSON.parse(text) };
  } catch (err) {
    return { errors: [{ path: file, message: `invalid JSON: ${(err as Error).message}` }] };
  }
}

function summarizeLayer(
  layer: Record<string, unknown>,
  assets?: Map<string, ResolvedAsset>,
): Record<string, unknown> {
  // Effective values: authored + theme-resolved (the load gate filled theme
  // defaults in) + the renderer's built-in defaults — what a render will use.
  const summary: Record<string, unknown> = {
    id: layer.id,
    type: layer.type,
    visible: layer.visible ?? LAYER_DEFAULTS.visible,
    opacity: layer.opacity ?? LAYER_DEFAULTS.opacity,
    position: layer.position,
    size: layer.size,
  };
  if (layer.rotation !== undefined) summary.rotation = layer.rotation;
  if (layer.mirror !== undefined) summary.mirror = layer.mirror;
  if (layer.effects !== undefined) summary.effects = layer.effects;
  if (layer.type === "image") {
    summary.asset = layer.asset;
    summary.fit = layer.fit ?? LAYER_DEFAULTS.fit;
    if (layer.crop !== undefined) summary.crop = layer.crop;
    // Fail fast like the old `.get(id)!`: a validated image layer's asset is
    // always resolved, so a miss here is a contract bug, not an empty field.
    if (assets) summary.resolvedAsset = resolvedAssetSummary(assets.get(layer.id as string)!);
  } else if (layer.type === "shape") {
    summary.shape = layer.shape;
    if (layer.radius !== undefined) summary.radius = layer.radius;
    if (layer.fill !== undefined) summary.fill = withAngle(layer.fill);
    else summary.color = layer.color ?? LAYER_DEFAULTS.color;
    if (layer.border !== undefined) summary.border = layer.border;
  } else if (layer.type === "group") {
    if (layer.scale !== undefined) summary.scale = layer.scale;
    summary.layers = (layer.layers as Record<string, unknown>[]).map((child) =>
      summarizeLayer(child, assets),
    );
  } else {
    if (layer.text !== undefined) summary.text = layer.text;
    if (layer.spans !== undefined) summary.spans = layer.spans;
    summary.font = layer.font;
    if (layer.fontSize !== undefined) summary.fontSize = layer.fontSize;
    if (layer.autoFit !== undefined) summary.autoFit = layer.autoFit;
    // The face's natural weight is the effective weight fallback.
    summary.weight = layer.weight ?? resolveFace(layer.font as string).weight;
    if (layer.tracking !== undefined) summary.tracking = layer.tracking;
    if (layer.casing !== undefined) summary.casing = layer.casing;
    if (layer.fill !== undefined) summary.fill = withAngle(layer.fill);
    else summary.color = layer.color ?? LAYER_DEFAULTS.color;
    if (layer.stroke !== undefined) summary.stroke = layer.stroke;
    if (layer.shadows !== undefined) summary.shadows = layer.shadows;
    summary.align = layer.align ?? LAYER_DEFAULTS.align;
    summary.lineHeight = layer.lineHeight ?? LAYER_DEFAULTS.lineHeight;
  }
  return summary;
}

/** Effective gradient fill for display: the angle default surfaced. */
function withAngle(fill: unknown): Record<string, unknown> {
  const { angle, ...rest } = fill as { angle?: number };
  return { ...rest, angle: angle ?? LAYER_DEFAULTS.fillAngle };
}

function resolvedAssetSummary(resolved: {
  scope: string;
  id?: string;
  kind?: string;
  path?: string;
  hash: string;
  mediaType: string;
}): Record<string, unknown> {
  return {
    scope: resolved.scope,
    ...(resolved.id !== undefined ? { id: resolved.id } : {}),
    ...(resolved.kind !== undefined ? { kind: resolved.kind } : {}),
    ...(resolved.path !== undefined ? { path: resolved.path } : {}),
    hash: resolved.hash,
    mediaType: resolved.mediaType,
  };
}

async function dispatch(args: string[]): Promise<CliResult> {
  const [cmd, file, ...rest] = args;

  if (cmd === "schema" && file === undefined) return ok(SCENE_SCHEMA);
  if (cmd === "schema" && file) return usageError(`"scene schema" takes no arguments`);

  if (cmd === "themes" && file === undefined)
    return ok({
      ok: true,
      themes: THEMES.map((t) => ({
        name: t.name,
        description: t.description,
        revision: themeRevision(t),
      })),
    });
  if (cmd === "templates" && file === undefined)
    return ok({
      ok: true,
      templates: TEMPLATES.map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.themeName ? { theme: t.themeName } : {}),
      })),
    });
  if ((cmd === "themes" || cmd === "templates") && file)
    return usageError(`"scene ${cmd}" takes no arguments`);

  if (cmd === "init" && file) {
    let outArg: string | undefined;
    if (rest.length === 2 && rest[0] === "--out") outArg = rest[1];
    else if (rest.length !== 0) return usageError("init accepts at most one --out <path>");
    let template;
    try {
      template = getTemplate(file);
    } catch (err) {
      return usageError((err as Error).message);
    }
    const scene = buildScene(template);
    // Bundled data still goes through the one gate — a broken template fails
    // loudly here instead of shipping an invalid Scene to an agent.
    const result = await loadScene(
      outArg ? path.dirname(path.resolve(outArg)) : process.cwd(),
      () => scanLibrary(LIBRARY_ROOT),
      scene,
    );
    if (!result.ok) return invalid(result.errors);
    if (!outArg) return ok({ ok: true, scene });
    const output = path.resolve(outArg);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(scene, null, 2) + "\n");
    return ok({
      ok: true,
      output,
      schemaVersion: SCHEMA_VERSION,
      layerCount: countLayers(scene.layers),
      ...(scene.theme ? { theme: scene.theme } : {}),
    });
  }

  if ((cmd === "validate" || cmd === "inspect" || cmd === "render") && file) {
    if (cmd !== "render" && rest.length)
      return usageError(`unexpected arguments: ${rest.join(" ")}`);
    let outArg: string | undefined;
    if (cmd === "render") {
      if (rest.length === 2 && rest[0] === "--out") outArg = rest[1];
      else if (rest.length !== 0) return usageError("render accepts at most one --out <path>");
    }

    const read = await readSceneFile(file);
    if ("errors" in read) return invalid(read.errors);
    // The one validation gate — every failure lands here, before any browser.
    // The library is a provider: scanned only if the scene names a library asset.
    const result = await loadScene(
      path.dirname(path.resolve(file)),
      () => scanLibrary(LIBRARY_ROOT),
      read.raw,
    );
    if (!result.ok) return invalid(result.errors);
    const { resolved } = result;

    if (cmd === "validate") {
      return ok({
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        layerCount: countLayers(resolved.scene.layers),
      });
    }

    if (cmd === "inspect") {
      return ok({
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        canvas: resolved.scene.canvas,
        ...(resolved.scene.theme ? { theme: resolved.scene.theme } : {}),
        layerCount: countLayers(resolved.scene.layers),
        layers: resolved.scene.layers.map((layer) =>
          summarizeLayer(layer as unknown as Record<string, unknown>, resolved.assets),
        ),
      });
    }

    const sceneFile = path.resolve(file);
    const projectDir = path.dirname(sceneFile);
    const output = outArg
      ? path.resolve(outArg)
      : path.join(projectDir, "out", `${path.basename(sceneFile, ".json")}.png`);
    // Render output belongs beside the scene — the same containment its
    // project-scope assets obey, so a scene read/write never crosses its directory.
    const outside =
      path.relative(projectDir, output).startsWith("..") ||
      path.isAbsolute(path.relative(projectDir, output));
    if (outside)
      return usageError(
        `--out "${outArg}" must stay inside the scene's directory (${projectDir})`,
      );
    const { png, width, height, warnings } = await renderScene(resolved);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, png);
    return ok({ ok: true, output, width, height, warnings });
  }

  return usageError(
    cmd === undefined
      ? "missing command — expected schema, themes, templates, init, inspect, validate, or render"
      : `unknown command "${cmd}" — expected schema, themes, templates, init, inspect, validate, or render`,
  );
}

/**
 * The error boundary every command reads through: an unexpected failure
 * (render crash, I/O error, corrupt library) is structured JSON like any
 * other — never a stack trace on stdout's contract.
 */
export async function run(args: string[]): Promise<CliResult> {
  const [cmd] = args;
  try {
    return await dispatch(args);
  } catch (err) {
    return invalid([
      {
        path: cmd ?? "scene",
        message: (err as Error).message || String(err),
      },
    ]);
  }
}

if (import.meta.main) {
  const { exitCode, output } = await run(process.argv.slice(2));
  console.log(JSON.stringify(output, null, 2));
  await closeBrowser();
  process.exit(exitCode);
}
