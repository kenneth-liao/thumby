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
import { existsSync } from "node:fs";
import path from "node:path";
import { LIBRARY_ROOT, scanLibrary, type Library, type ResolvedAsset } from "./assets.js";
import { SCENE_SCHEMA, LAYER_DEFAULTS, loadScene, SCHEMA_VERSION, type SceneError } from "./scene.js";
import { resolveVariant } from "./variants.js";
import { resolveFace } from "./fonts.js";
import { renderScene, renderContactSheet, countLayers } from "./scene-render.js";
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
  --out <path>   init: where to write the Scene — inside the current
                 directory; an existing file needs --force
                 (default: print as "scene")
                 render: output path inside the scene's directory
                 (default: <scene-dir>/out/<scene-basename>.png;
                 with one --variant: <scene-dir>/out/<scene>.<variant>.png)
  --variant <name[,name...]>
                 render: render one or more named Variants instead of the
                 base Scene. One variant renders alone; several render as a
                 batch plus a contact sheet (<scene-dir>/out/<scene>.contact.png)
                 showing every output at 168px wide with its name.
                 inspect: inspect the Scene resolved with that Variant —
                 the variant's stored sparse changes come back verbatim.
  --force        init: allow --out to overwrite an existing file

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
  // Built-in defaults surface for visible, opacity, fit, align, lineHeight,
  // color, and fill angle; properties with no built-in (radius, border,
  // stroke, shadows, scale, effects) appear only when set.
  const summary: Record<string, unknown> = {
    id: layer.id,
    type: layer.type,
    visible: layer.visible ?? LAYER_DEFAULTS.visible,
    opacity: layer.opacity ?? LAYER_DEFAULTS.opacity,
  };
  // A connector has no position/size — its geometry derives from its targets.
  if (layer.position !== undefined) summary.position = layer.position;
  if (layer.size !== undefined) summary.size = layer.size;
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
  } else if (layer.type === "connector") {
    summary.from = layer.from;
    summary.to = layer.to;
    if (layer.bow !== undefined) summary.bow = layer.bow;
    if (layer.dash !== undefined) summary.dash = layer.dash;
    summary.color = layer.color ?? LAYER_DEFAULTS.color;
    summary.width = layer.width ?? LAYER_DEFAULTS.connectorWidth;
    summary.arrow = layer.arrow ?? false;
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

/** True when `target` escapes `dir` — the containment rule render outputs obey. */
const outsideDir = (dir: string, target: string): boolean => {
  const relative = path.relative(dir, target);
  return relative.startsWith("..") || path.isAbsolute(relative);
};

/**
 * Render one or more named Variants of an already-gated Scene document.
 * Each Variant resolves (sparse patch over the base) and re-enters the one
 * gate; every output lands in the scene's out/ directory named after its
 * variant. A batch also writes one contact sheet — every output at 168px
 * wide with its name — the full-size PNGs remain the review originals.
 */
async function renderVariants(
  projectDir: string,
  baseName: string,
  library: () => Promise<Library>,
  raw: unknown,
  names: string[],
  outArg: string | undefined,
): Promise<CliResult> {
  if (names.length === 0 || names.some((n) => !n))
    return usageError("--variant needs at least one variant name");
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return usageError(`variant "${dup}" is listed more than once`);
  if (names.length > 1 && outArg)
    return usageError("--out applies to a single-variant render — batches name their own outputs");
  // Phase 1 — resolve, gate, and render everything before any file is
  // written: a failing variant leaves the out/ directory untouched instead
  // of silently half-updated.
  const rendered: { name: string; png: Buffer; width: number; height: number; warnings: string[]; output: string }[] = [];
  for (const name of names) {
    const applied = resolveVariant(raw, name);
    if (!applied.ok) return invalid(applied.errors);
    const result = await loadScene(projectDir, library, applied.raw);
    if (!result.ok) return invalid(result.errors);
    const output =
      outArg ?? path.join(projectDir, "out", `${baseName}.${name}.png`);
    if (outsideDir(projectDir, output))
      return usageError(
        `--out "${outArg}" must stay inside the scene's directory (${projectDir})`,
      );
    const { png, width, height, warnings } = await renderScene(result.resolved);
    rendered.push({ name, png, width, height, warnings, output });
  }
  // Phase 2 — every render succeeded: write the outputs and the batch's
  // contact sheet (every output at 168px wide, labeled with its name).
  const outputs: Record<string, unknown>[] = [];
  const sheets: { label: string; png: Buffer }[] = [];
  for (const r of rendered) {
    await mkdir(path.dirname(r.output), { recursive: true });
    await writeFile(r.output, r.png);
    outputs.push({ variant: r.name, output: r.output, width: r.width, height: r.height, warnings: r.warnings });
    sheets.push({ label: r.name, png: r.png });
  }
  let contact: Record<string, unknown> | undefined;
  if (sheets.length > 1) {
    const sheet = await renderContactSheet(sheets);
    const contactPath = path.join(projectDir, "out", `${baseName}.contact.png`);
    await mkdir(path.dirname(contactPath), { recursive: true });
    await writeFile(contactPath, sheet.png);
    contact = { output: contactPath, width: sheet.width, height: sheet.height };
  }
  return ok({ ok: true, outputs, ...(contact ? { contact } : {}) });
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
    let force = false;
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] === "--out" && rest[i + 1] !== undefined) outArg = rest[i + 1];
      else if (rest[i] === "--force") (force = true), (i -= 1);
      else return usageError("init accepts --out <path> and --force");
    }
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
    // init's project root is the current directory — the same containment
    // discipline render --out applies to the scene directory. An existing
    // file is never clobbered silently; --force is the explicit intent.
    const cwd = process.cwd();
    const relative = path.relative(cwd, output);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      return usageError(`--out "${outArg}" must stay inside the current directory (${cwd})`);
    if (!force && existsSync(output))
      return usageError(`--out "${outArg}" already exists — pass --force to overwrite it`);
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
    let outArg: string | undefined;
    let variantArg: string | undefined;
    // Strict flag parsing: a flag is never consumed as a value, and no flag
    // repeats — ambiguity between two homes for one option is a usage error.
    const setFlag = (flag: string, value: string | undefined): string | undefined => {
      if (value === undefined || value.startsWith("--"))
        return `missing value after "${flag}"`;
      return undefined;
    };
    if (cmd === "render") {
      for (let i = 0; i < rest.length; i += 2) {
        if (rest[i] === "--out" && outArg === undefined) {
          const bad = setFlag("--out", rest[i + 1]);
          if (bad) return usageError(bad);
          outArg = rest[i + 1];
        } else if (rest[i] === "--variant" && variantArg === undefined) {
          const bad = setFlag("--variant", rest[i + 1]);
          if (bad) return usageError(bad);
          variantArg = rest[i + 1];
        } else
          return usageError("render accepts --out <path> and --variant <name[,name...]>, each at most once");
      }
    } else if (cmd === "inspect") {
      if (rest.length === 2 && rest[0] === "--variant") variantArg = rest[1];
      else if (rest.length !== 0)
        return usageError("inspect accepts at most one --variant <name>");
    } else if (rest.length) return usageError(`unexpected arguments: ${rest.join(" ")}`);

    const read = await readSceneFile(file);
    if ("errors" in read) return invalid(read.errors);
    // The one validation gate — every failure lands here, before any browser.
    // The library is a provider: scanned only if the scene names a library asset.
    const sceneDir = path.dirname(path.resolve(file));
    const result = await loadScene(sceneDir, () => scanLibrary(LIBRARY_ROOT), read.raw);
    if (!result.ok) return invalid(result.errors);
    const { resolved } = result;

    if (cmd === "validate") {
      return ok({
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        layerCount: countLayers(resolved.scene.layers),
        ...(resolved.scene.variants
          ? { variantCount: Object.keys(resolved.scene.variants).length }
          : {}),
      });
    }

    if (cmd === "render" && variantArg !== undefined)
      return renderVariants(
        sceneDir,
        path.basename(file, ".json"),
        () => scanLibrary(LIBRARY_ROOT),
        read.raw,
        variantArg.split(","),
        outArg,
      );

    if (cmd === "inspect") {
      // Variant inspection: the merged Scene resolved through the same gate,
      // plus the Variant's stored changes verbatim — unchanged facts appear
      // only in the base layers, never duplicated in variant storage.
      if (variantArg !== undefined) {
        const applied = resolveVariant(read.raw, variantArg);
        if (!applied.ok) return invalid(applied.errors);
        const vResult = await loadScene(sceneDir, () => scanLibrary(LIBRARY_ROOT), applied.raw);
        if (!vResult.ok) return invalid(vResult.errors);
        // Both assertions hold by construction: the base gate validated the
        // document (so variants exist and are structurally sound) and
        // resolveVariant just succeeded on this same name.
        const stored = resolved.scene.variants![variantArg]!;
        return ok({
          ok: true,
          schemaVersion: SCHEMA_VERSION,
          canvas: vResult.resolved.scene.canvas,
          ...(vResult.resolved.scene.theme ? { theme: vResult.resolved.scene.theme } : {}),
          variant: {
            name: variantArg,
            ...(stored.description !== undefined ? { description: stored.description } : {}),
            changes: stored.changes,
          },
          layerCount: countLayers(vResult.resolved.scene.layers),
          layers: vResult.resolved.scene.layers.map((layer) =>
            summarizeLayer(layer as unknown as Record<string, unknown>, vResult.resolved.assets),
          ),
        });
      }
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
    if (outsideDir(projectDir, output))
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
