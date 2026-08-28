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
import type { Page } from "playwright";
import { LIBRARY_ROOT, scanLibrary, contentHash, type Library, type ResolvedAsset } from "./assets.js";
import { SCENE_SCHEMA, LAYER_DEFAULTS, loadScene, SCHEMA_VERSION, type SceneError, type ResolvedScene } from "./scene.js";
import { resolveVariant } from "./variants.js";
import { resolveFace } from "./fonts.js";
import { renderScene, renderContactSheet, countLayers } from "./scene-render.js";
import { THEMES, themeRevision } from "./themes.js";
import { buildScene, getTemplate, TEMPLATES } from "./templates.js";
import {
  buildManifest,
  manifestPathFor,
  readManifest,
  writeManifest,
} from "./manifest.js";
import { finalizeRender, type Optimization } from "./finalize.js";
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
  bun run scene render   <scene.json>   Render to PNG (1280×720). The output must fit
                                        YouTube's 2 MB limit: compliant renders pass
                                        through untouched; oversized ones are optimized
                                        locally (lossless first, then deterministic
                                        palette quantization — dimensions never change);
                                        a render that cannot comply fails with its size.
  bun run scene rerender <manifest.json>
                         Re-render from a Render manifest: verifies the scene
                         bytes and every recorded Asset identity first — a
                         missing or changed input fails instead of silently
                         resolving newer content — then rewrites the recorded
                         outputs at their recorded paths. Works after moving
                         the whole project directory.

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
could not fit at its min floor) and write a Render manifest beside the
output(s) (<out>.manifest.json) recording the scene identity, selected
variants, exact Asset identities, tool version, and outputs — every path
in it is relative to the manifest itself, so the project can be relocated
and re-rendered offline via "scene rerender". Exit codes: 0 ok, 1 invalid
scene or render failure, 2 usage error.
Rendering, validation, inspection, and rerendering are offline and never
start generation.
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
): Promise<{ raw: unknown; bytes: Buffer } | { errors: SceneError[] }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    return {
      errors: [{ path: file, message: `cannot read scene file: ${(err as Error).message}` }],
    };
  }
  try {
    return { raw: JSON.parse(bytes.toString("utf8")), bytes };
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
 * The invocation writes one Render manifest beside the outputs: a
 * single-variant render pairs with its PNG (<scene>.<variant>.manifest.json),
 * a batch writes <scene>.variants.manifest.json covering every output and
 * the contact sheet (a variant name can never contain a dot, so the two
 * names can never collide).
 */
async function renderVariants(
  projectDir: string,
  baseName: string,
  library: () => Promise<Library>,
  raw: unknown,
  names: string[],
  outArg: string | undefined,
  sceneFile: string,
  sceneSha256: string,
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
  const rendered: {
    name: string;
    png: Buffer;
    width: number;
    height: number;
    warnings: string[];
    output: string;
    resolved: ResolvedScene;
    optimization?: Optimization;
  }[] = [];
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
    // Finalization happens in phase 1: an uncompliant render leaves out/
    // untouched instead of half-updating it.
    const fin = finalizeRender(png, { at: output });
    if (!fin.ok) return invalid(fin.errors);
    rendered.push({
      name,
      png: fin.png,
      width,
      height,
      warnings,
      output,
      resolved: result.resolved,
      ...(fin.optimization ? { optimization: fin.optimization } : {}),
    });
  }
  // Phase 2 — every render succeeded: write the outputs and the batch's
  // contact sheet (every output at 168px wide, labeled with its name), then
  // the manifest that records exactly what was written.
  const outputs: Record<string, unknown>[] = [];
  const sheets: { label: string; png: Buffer }[] = [];
  for (const r of rendered) {
    await mkdir(path.dirname(r.output), { recursive: true });
    await writeFile(r.output, r.png);
    outputs.push({
      variant: r.name,
      output: r.output,
      width: r.width,
      height: r.height,
      bytes: r.png.length,
      warnings: r.warnings,
      ...(r.optimization ? { optimization: r.optimization } : {}),
    });
    sheets.push({ label: r.name, png: r.png });
  }
  let contact: Record<string, unknown> | undefined;
  let contactInput: Parameters<typeof buildManifest>[0]["contact"];
  if (sheets.length > 1) {
    const sheet = await renderContactSheet(sheets);
    const contactPath = path.join(projectDir, "out", `${baseName}.contact.png`);
    await mkdir(path.dirname(contactPath), { recursive: true });
    await writeFile(contactPath, sheet.png);
    contact = { output: contactPath, width: sheet.width, height: sheet.height };
    contactInput = { output: contactPath, width: sheet.width, height: sheet.height, png: sheet.png };
  }
  const manifestFile =
    rendered.length === 1
      ? manifestPathFor(rendered[0]!.output)
      : path.join(projectDir, "out", `${baseName}.variants.manifest.json`);
  const manifest = buildManifest({
    manifestDir: path.dirname(manifestFile),
    sceneFile,
    sceneSha256,
    variant: rendered.map((r) => r.name),
    outputs: rendered.map((r) => ({
      output: r.output,
      width: r.width,
      height: r.height,
      warnings: r.warnings,
      png: r.png,
      resolved: r.resolved,
      ...(r.optimization ? { optimization: r.optimization } : {}),
    })),
    ...(contactInput ? { contact: contactInput } : {}),
  });
  await writeManifest(manifestFile, manifest);
  return ok({
    ok: true,
    outputs,
    manifest: manifestFile,
    ...(contact ? { contact } : {}),
  });
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
        path.resolve(file),
        contentHash(read.bytes),
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
    const fin = finalizeRender(png, { at: output });
    if (!fin.ok) return invalid(fin.errors);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, fin.png);
    const manifestFile = manifestPathFor(output);
    await writeManifest(
      manifestFile,
      buildManifest({
        manifestDir: path.dirname(manifestFile),
        sceneFile,
        sceneSha256: contentHash(read.bytes),
        variant: [],
        outputs: [
          {
            output,
            width,
            height,
            warnings,
            png: fin.png,
            resolved,
            ...(fin.optimization ? { optimization: fin.optimization } : {}),
          },
        ],
      }),
    );
    return ok({
      ok: true,
      output,
      width,
      height,
      bytes: fin.png.length,
      warnings,
      manifest: manifestFile,
      ...(fin.optimization ? { optimization: fin.optimization } : {}),
    });
  }

  if (cmd === "rerender" && file && rest.length === 0) return rerenderManifest(file);
  if (cmd === "rerender")
    return usageError(`"scene rerender" takes exactly one manifest path`);

  return usageError(
    cmd === undefined
      ? "missing command — expected schema, themes, templates, init, inspect, validate, render, or rerender"
      : `unknown command "${cmd}" — expected schema, themes, templates, init, inspect, validate, render, or rerender`,
  );
}

/**
 * Re-render from a Render manifest. Every recorded identity is verified
 * before anything is written: the scene file's exact bytes (the manifest's
 * scene.sha256), then each output's resolved Asset identities against a
 * fresh pass through the load gate. A missing input fails at the gate with
 * its field error; a changed input — including an unpinned reference that
 * now resolves to newer content — fails identity verification here instead
 * of silently rendering different pixels. All paths resolve relative to the
 * manifest file's own directory, so moving the whole project directory
 * changes nothing; outputs stay contained in the scene's directory, the
 * same rule `render --out` enforces.
 *
 * `page` is a test seam: rendering in an existing (e.g. route-blocked) page.
 */
export async function rerenderManifest(
  manifestFile: string,
  opts?: { page?: Page },
): Promise<CliResult> {
  const read = await readManifest(manifestFile);
  if (!read.ok) return invalid(read.errors);
  const manifest = read.manifest;
  const manifestDir = path.dirname(path.resolve(manifestFile));
  const sceneFile = path.resolve(manifestDir, manifest.scene.path);
  const sceneDir = path.dirname(sceneFile);
  // Output containment: the recorded outputs must land inside the scene's
  // directory — the same rule render --out enforces, so a manifest can never
  // direct a write outside the project even if hand-edited.
  const contained = (rel: string, at: string): SceneError | undefined =>
    outsideDir(sceneDir, path.resolve(manifestDir, rel))
      ? {
          path: at,
          message: `"${rel}" escapes the scene's directory (${sceneDir}) — manifest outputs must stay beside the scene`,
        }
      : undefined;
  for (const [i, o] of manifest.outputs.entries()) {
    const bad = contained(o.output, `outputs[${i}].output`);
    if (bad) return invalid([bad]);
  }
  if (manifest.contact) {
    const bad = contained(manifest.contact.output, "contact.output");
    if (bad) return invalid([bad]);
  }

  // Scene identity: the exact bytes the render used, or nothing proceeds.
  let sceneBytes: Buffer;
  try {
    sceneBytes = await readFile(sceneFile);
  } catch (err) {
    return invalid([
      {
        path: "scene.path",
        message: `cannot read the manifest's scene file "${manifest.scene.path}": ${(err as Error).message}`,
      },
    ]);
  }
  const sceneHash = contentHash(sceneBytes);
  if (sceneHash !== manifest.scene.sha256)
    return invalid([
      {
        path: "scene.sha256",
        message:
          `the scene file changed since this render: the manifest recorded ${manifest.scene.sha256.slice(0, 12)}… ` +
          `but it now hashes to ${sceneHash.slice(0, 12)}….\n` +
          `Rerender would not reproduce the recorded outputs — edit the scene and render normally instead.`,
      },
    ]);
  let raw: unknown;
  try {
    raw = JSON.parse(sceneBytes.toString("utf8"));
  } catch (err) {
    return invalid([{ path: "scene.path", message: `invalid JSON: ${(err as Error).message}` }]);
  }

  // One resolved render per output, in recorded order: the i-th output is the
  // render of variant[i] (or the base Scene when no variant was selected).
  const selected = manifest.variant.length ? manifest.variant : [null];
  if (selected.length !== manifest.outputs.length)
    return invalid([
      {
        path: "outputs",
        message: `${manifest.outputs.length} outputs recorded for ${manifest.variant.length} selected variants — the manifest is inconsistent`,
      },
    ]);
  const rendered: {
    output: string;
    png: Buffer;
    width: number;
    height: number;
    warnings: string[];
    optimization?: Optimization;
  }[] = [];
  for (const [i, name] of selected.entries()) {
    let doc = raw;
    if (name !== null) {
      const applied = resolveVariant(raw, name);
      if (!applied.ok) return invalid(applied.errors);
      doc = applied.raw;
    }
    const result = await loadScene(sceneDir, () => scanLibrary(LIBRARY_ROOT), doc);
    if (!result.ok) return invalid(result.errors);
    // Asset identity verification — the manifest is the exactness contract:
    // every recorded layer must still resolve to the very bytes it rendered.
    for (const [j, a] of manifest.outputs[i]!.assets.entries()) {
      const resolved = result.resolved.assets.get(a.layer);
      if (!resolved)
        return invalid([
          {
            path: `outputs[${i}].assets[${j}].layer`,
            message: `layer "${a.layer}" is recorded in the manifest but has no resolved asset in this scene`,
          },
        ]);
      if (resolved.hash !== a.hash)
        return invalid([
          {
            path: `outputs[${i}].assets[${j}].hash`,
            message:
              `asset identity mismatch for layer "${a.layer}": the manifest recorded ${a.hash.slice(0, 12)}… ` +
              `but the input now resolves to ${resolved.hash.slice(0, 12)}….\n` +
              `The content changed since the render — re-render normally to refresh the manifest.`,
          },
        ]);
    }
    const { png, width, height, warnings } = await renderScene(result.resolved, opts);
    const output = path.resolve(manifestDir, manifest.outputs[i]!.output);
    // Rerender publishes the same final contract: every rewritten output must
    // still satisfy the 2 MB limit, through the same deterministic pipeline.
    const fin = finalizeRender(png, { at: output });
    if (!fin.ok) return invalid(fin.errors);
    rendered.push({
      output,
      png: fin.png,
      width,
      height,
      warnings,
      ...(fin.optimization ? { optimization: fin.optimization } : {}),
    });
  }
  for (const r of rendered) {
    await mkdir(path.dirname(r.output), { recursive: true });
    await writeFile(r.output, r.png);
  }
  let contact: Record<string, unknown> | undefined;
  if (manifest.contact) {
    const sheet = await renderContactSheet(
      rendered.map((r, i) => ({ label: selected[i] ?? "base", png: r.png })),
    );
    const contactPath = path.resolve(manifestDir, manifest.contact.output);
    await mkdir(path.dirname(contactPath), { recursive: true });
    await writeFile(contactPath, sheet.png);
    contact = { output: contactPath, width: sheet.width, height: sheet.height };
  }
  return ok({
    ok: true,
    manifest: path.resolve(manifestFile),
    variant: manifest.variant,
    outputs: rendered.map((r, i) => ({
      ...(selected[i] !== null ? { variant: selected[i] } : {}),
      output: r.output,
      width: r.width,
      height: r.height,
      bytes: r.png.length,
      warnings: r.warnings,
      ...(r.optimization ? { optimization: r.optimization } : {}),
    })),
    ...(contact ? { contact } : {}),
  });
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
