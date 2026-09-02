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
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  LIBRARY_ROOT,
  scanLibrary,
  contentHash,
  trialOverrideWarning as trialOverrideWarningFor,
  trialOutputName,
  type Library,
  type ResolvedAsset,
} from "./assets.js";
import { SCENE_SCHEMA, LAYER_DEFAULTS, loadScene, SCHEMA_VERSION, type SceneError, type ResolvedScene } from "./scene.js";
import { resolveVariant } from "./variants.js";
import { resolveFace } from "./fonts.js";
import { renderScene, renderContactSheet, renderGuidelines, countLayers } from "./scene-render.js";
import { PROTECTED_REGIONS, findSafeAreaViolations } from "./safe-area.js";
import { THEMES, themeRevision } from "./themes.js";
import { buildScene, getTemplate, TEMPLATES } from "./templates.js";
import { checkReference, diffPng, renderCompareSheet } from "./compare.js";
import { importReference, acquireSceneLock, atomicReplace, atomicCreate } from "./reference-import.js";
import {
  buildManifest,
  manifestPathFor,
  readManifest,
  renderOutputConflict,
  writeManifest,
} from "./manifest.js";
import { finalizeRender, type Optimization } from "./finalize.js";
import { outsideDir } from "./paths.js";
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
  bun run scene compare  <scene.json>   Compare the Scene's Render with its associated Reference
                                        Thumbnail (reference.path): writes an offline sheet
                                        (side by side at full size and 168px, an adjustable
                                        alpha overlay, and a per-channel difference view) plus
                                        the diff and render PNGs into out/. Review artifacts
                                        only — never a manifest, never the final Render.
  bun run scene reference import <scene.json> <file>
                                        Normalize a local raster image (PNG, JPEG, or
                                        WebP) to the canonical Reference Thumbnail profile
                                        (exact 1280×720 PNG), store the copy inside the scene's
                                        directory, and associate it with the Scene atomically.
                                        --source <text> records user-supplied provenance.
  bun run scene render   <scene.json>   Render to PNG (1280×720). The output must fit
                                        YouTube's 2 MB limit: compliant renders pass
                                        through untouched; oversized ones are optimized
                                        locally (lossless first, then deterministic
                                        palette quantization — dimensions never change);
                                        a render that cannot comply fails with its size.
  bun run scene guidelines <scene.json> Render the safe-area guideline view: the Scene
                                        exactly as render would draw it, plus the
                                        protected regions (duration badge, progress bar)
                                        outlined. A review artifact — written to its own
                                        file, never the final output, never a manifest.
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
                 guidelines: output path inside the scene's directory
                 (default: <scene-dir>/out/<scene-basename>.guidelines.png)
  --variant <name[,name...]>
                 render: render one or more named Variants instead of the
                 base Scene. One variant renders alone; several render as a
                 batch plus a contact sheet (<scene-dir>/out/<scene>.contact.png)
                 showing every output at 168px wide with its name.
                 inspect: inspect the Scene resolved with that Variant —
                 the variant's stored sparse changes come back verbatim.
  --force        init: allow --out to overwrite an existing file
  --experimental render only: permit trial Creator Assets (approval:
                 "trial") in this render. The output is explicitly non-final:
                 the default output name carries a .trial suffix, and when
                 trial Creator Asset(s) were actually used, the result and
                 manifest record "experimental": true and every output's
                 warnings say the Render is non-final (rerender keeps the
                 marker). validate, inspect, guidelines, and a non-
                 experimental rerender never relax the gate — approve the
                 asset (bun run library approve <id>) instead.

Themes and templates
  A Scene may pin a bundled theme: "theme": { "name", "revision" }. Precedence
  is one rule — explicit layer value, then theme default, then the renderer's
  built-in default. The revision is the sha-256 of the theme's content;
  loading re-derives it and fails loudly on drift, so old Scenes never render
  with silently changed theme content. "scene init" bakes a template's layers
  into a plain Scene (no runtime template reference) with the theme pin set.

Output is JSON on stdout: { "ok": true, ... } or { "ok": false, "errors": [...] }.
Successful renders carry a "warnings" array (e.g. an auto-fit layer that
could not fit at its min floor, or a safe-area violation naming the layer
that intersects YouTube's duration-badge or progress-bar region) and write
a Render manifest beside the output(s) (<out>.manifest.json) recording the
scene identity, selected variants, exact Asset identities, tool version,
and outputs — every path in it is relative to the manifest itself, so the
project can be relocated and re-rendered offline via "scene rerender".
"scene validate" reports the structured safeAreaViolations array. Exit
codes: 0 ok, 1 invalid scene or render failure, 2 usage error.
Rendering, validation, inspection, and rerendering are offline and never
start generation.

Safe areas (REQ-012)
  The YouTube duration-badge and progress regions are defined once in
  src/safe-area.ts. validate and render report visible layers whose painted
  footprint intersects a region — as structured violations and as warnings
  respectively. Violations never fail a render: a full-canvas plate
  legitimately intersects, and accepting the overlap is the reviewer's call
  (ADR-0005). "scene guidelines" renders the regions for visual review
  without entering the final output.

Reference Thumbnail import (DEC-001..004)
  "scene reference import <scene> <file>" is one normalization boundary plus
  one atomic transaction, serialized per Scene by a lock file (<scene>.lock —
  leave it in place: it relocates with the bundle, and a crashed import's
  lock is recovered automatically). Supported input is exactly a regular
  local PNG, JPEG, or WebP file; it may live anywhere — it is external
  source material. Ingestion is resource-bounded: the file is opened and the
  opened handle is measured (regular files only), the 64 MB encoded cap is
  enforced on that measurement and re-bounded by the read window itself, and
  the header's declared geometry must fit the decoded-pixel budget before
  the browser rasterizes anything. Normalization is non-distorting and
  non-subjective: a 16:9 input is uniformly rescaled to exactly 1280×720
  (1:1 when already exact); any other aspect is refused before anything is
  written, because fitting it would require an unstated subjective crop or a
  distortion — crop or resize locally with stated intent, then import. The
  copy is stored inside the scene's directory as <scene>.reference.png (a
  -2, -3… suffix is used when a name is taken — the reservation is an
  exclusive no-replace create, so an existing file, directory, or symlink
  alias is never overwritten or written through, and the previous
  association's file always survives). --source records user-supplied
  provenance as reference.source free text: never resolved as a path — no
  external file dependency — and never a second stored hash (identity derives
  from bytes). Before the Scene file is replaced, the complete resulting
  Scene passes the same validation gate as "scene validate", and the Scene's
  current bytes are compared to the bytes this import first read — an
  intervening edit fails closed. Any failure — missing or unreadable input,
  refused normalization, failed validation, a changed Scene, or a failed
  commit — rolls the new copy back and leaves the previous Scene and its
  associated files byte-identical and usable; a rollback whose removal fails
  is reported as a second error naming the retained path. The renderer never
  reads the reference, and the Render manifest never records it as a Render
  input (DEC-009): importing changes neither rendered pixels nor resolved
  Asset identities — the manifest's scene byte identity (its sha256)
  necessarily changes, because the reference metadata is part of the Scene
  bytes.

Scene replacement and the per-Scene lock
  Every in-repo writer that can replace an existing Scene participates in the
  same per-Scene transaction lock (<scene>.lock beside the scene's real path):
  "scene reference import" and "scene init --force" (over an existing file).
  On contention a writer waits only to the bounded timeout and then fails with
  the retained lock path named — a crashed holder's lock requires explicit
  operator cleanup, never automatic stealing. Fresh "scene init" publication
  is an atomic no-replace create: a writer that appears between the existence
  check and publication gets a refusal, never a silent overwrite. External
  (non-participating) edits to the Scene are still caught by the import's
  Scene-byte comparison immediately before commit.
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
    if (layer.adjust !== undefined) summary.adjust = layer.adjust;
    if (layer.tint !== undefined) summary.tint = layer.tint;
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

/**
 * The non-final marker for one resolved Scene (REQ-018): the shared marker,
 * fed the trial Creator Asset ids the Scene actually uses.
 */
function trialOverrideWarning(resolved: ResolvedScene): string | undefined {
  return trialOverrideWarningFor(
    [...resolved.assets.values()]
      .filter((a) => a.approval === "trial")
      .map((a) => a.id ?? "?"),
  );
}

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
  experimental: boolean,
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
  // The recorded non-final marker — derived from actual trial usage (INT-4),
  // not from the flag: --experimental on an all-approved scene must not mint
  // a manifest that carries a standing gate relaxation for future rerenders.
  let nonFinal = false;
  for (const name of names) {
    const applied = resolveVariant(raw, name);
    if (!applied.ok) return invalid(applied.errors);
    const result = await loadScene(projectDir, library, applied.raw, {
      allowTrialCreator: experimental,
    });
    if (!result.ok) return invalid(result.errors);
    const output =
      outArg ??
      (experimental
        ? trialOutputName(path.join(projectDir, "out", `${baseName}.${name}.png`))
        : path.join(projectDir, "out", `${baseName}.${name}.png`));
    if (outsideDir(projectDir, output))
      return usageError(
        `--out "${outArg}" must stay inside the scene's directory (${projectDir})`,
      );
    // renderScene assembles the complete warnings (scene-level + safe-area,
    // ADR-0005) — the one home every render path reads through. The
    // experimental override appends the non-final marker to the same set.
    const { png, width, height, warnings } = await renderScene(result.resolved);
    const trialWarning = trialOverrideWarning(result.resolved);
    const marked = trialWarning ? [trialWarning] : [];
    if (trialWarning) nonFinal = true;
    // Finalization happens in phase 1: an uncompliant render leaves out/
    // untouched instead of half-updating it.
    const fin = finalizeRender(png, { at: output });
    if (!fin.ok) return invalid(fin.errors);
    rendered.push({
      name,
      png: fin.png,
      width,
      height,
      warnings: [...warnings, ...marked],
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
    const contactPath = experimental
      ? trialOutputName(path.join(projectDir, "out", `${baseName}.contact.png`))
      : path.join(projectDir, "out", `${baseName}.contact.png`);
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
    experimental: nonFinal,
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
    ...(nonFinal ? { experimental: true } : {}),
    ...(contact ? { contact } : {}),
  });
}

async function dispatch(
  args: string[],
  deps?: { libraryRoot?: string; sceneLockTimeoutMs?: number },
): Promise<CliResult> {
  // The library root is a seam for tests (and a portable-library override):
  // every command reads the library through this one provider.
  const library = () => scanLibrary(deps?.libraryRoot ?? LIBRARY_ROOT);
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
      library,
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
    const sceneJson = () => Buffer.from(JSON.stringify(scene, null, 2) + "\n", "utf8");
    if (force && existsSync(output)) {
      // Replacing an existing Scene participates in the same per-Scene
      // transaction lock every replacing writer shares: contention waits only
      // to the bounded timeout and then fails with the retained lock path
      // named — a crashed holder's lock requires explicit operator cleanup.
      let real: string;
      try {
        real = await realpath(output);
      } catch (err) {
        return invalid([
          { path: "--out", message: `cannot replace "${output}": ${(err as Error).message}` },
        ]);
      }
      let lock;
      try {
        lock = await acquireSceneLock(`${real}.lock`, {
          timeoutMs: deps?.sceneLockTimeoutMs,
        });
      } catch (err) {
        return invalid([
          { path: "--out", message: `"${output}" could not be locked for replacement: ${(err as Error).message}` },
        ]);
      }
      try {
        await atomicReplace(output, sceneJson());
      } catch (err) {
        return invalid([
          { path: "--out", message: `could not write "${output}": ${(err as Error).message}` },
        ]);
      } finally {
        await lock.release();
      }
    } else {
      // A fresh Scene is published atomically and never replaces: `link` is
      // the no-replace create, so a writer that appears between the
      // existence check and publication gets EEXIST — a post-check write can
      // never silently overwrite a Scene another writer just created.
      try {
        await atomicCreate(output, sceneJson());
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST")
          return usageError(
            `--out "${outArg}" was created by another writer just now — refusing to overwrite it`,
          );
        throw err;
      }
    }
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
    let experimental = false;
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
        } else if (rest[i] === "--experimental" && !experimental) {
          experimental = true;
          i -= 1; // a boolean flag — the loop's += 2 would skip the next argument
        } else
          return usageError(
            "render accepts --out <path>, --variant <name[,name...]>, and --experimental, each at most once",
          );
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
    // render alone may relax the Creator approval gate (--experimental);
    // validate and inspect always enforce it.
    const sceneDir = path.dirname(path.resolve(file));
    const result = await loadScene(sceneDir, library, read.raw, {
      allowTrialCreator: cmd === "render" && experimental,
    });
    if (!result.ok) return invalid(result.errors);
    const { resolved } = result;
    if (cmd === "validate") {
      // The reference association (REQ-020) is review metadata, not Render
      // input — validate (and compare) read the file itself; render ignores
      // the field entirely. Unlike the safe-area precedent (ADR-0005), a bad
      // reference is a hard failure, not data: safe-area overlap is computed
      // geometry a reviewer may accept, while a reference that fails the gate
      // is an explicit authored association pointing at nothing usable — and
      // review tooling that silently ignores it produces false evidence.
      const ref = await checkReference(sceneDir, resolved.scene);
      if (!ref.ok) return invalid(ref.errors);
      return ok({
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        layerCount: countLayers(resolved.scene.layers),
        ...(resolved.scene.variants
          ? { variantCount: Object.keys(resolved.scene.variants).length }
          : {}),
        ...(resolved.scene.reference ? { reference: resolved.scene.reference.path } : {}),
        safeAreaViolations: findSafeAreaViolations(resolved),
      });
    }

    if (cmd === "render" && variantArg !== undefined)
      return renderVariants(
        sceneDir,
        path.basename(file, ".json"),
        library,
        read.raw,
        variantArg.split(","),
        outArg,
        path.resolve(file),
        contentHash(read.bytes),
        experimental,
      );

    if (cmd === "inspect") {
      // Variant inspection: the merged Scene resolved through the same gate,
      // plus the Variant's stored changes verbatim — unchanged facts appear
      // only in the base layers, never duplicated in variant storage.
      if (variantArg !== undefined) {
        const applied = resolveVariant(read.raw, variantArg);
        if (!applied.ok) return invalid(applied.errors);
        const vResult = await loadScene(sceneDir, library, applied.raw);
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
    const defaultOut = path.join(projectDir, "out", `${path.basename(sceneFile, ".json")}.png`);
    const output = outArg ? path.resolve(outArg) : experimental ? trialOutputName(defaultOut) : defaultOut;
    // Render output belongs beside the scene — the same containment its
    // project-scope assets obey, so a scene read/write never crosses its directory.
    if (outsideDir(projectDir, output))
      return usageError(
        `--out "${outArg}" must stay inside the scene's directory (${projectDir})`,
      );
    // renderScene assembles the complete warnings (scene-level + safe-area,
    // ADR-0005) — in the command output and the manifest alike. The
    // experimental override appends the non-final marker to the same set.
    const { png, width, height, warnings } = await renderScene(resolved);
    const trialWarning = trialOverrideWarning(resolved);
    const marked = trialWarning ? [trialWarning] : [];
    // The recorded marker derives from actual trial usage (INT-4): a flag
    // alone must not mint a standing bypass token on the manifest.
    const nonFinal = experimental && trialWarning !== undefined;
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
        experimental: nonFinal,
        outputs: [
          {
            output,
            width,
            height,
            warnings: [...warnings, ...marked],
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
      warnings: [...warnings, ...marked],
      manifest: manifestFile,
      ...(nonFinal ? { experimental: true } : {}),
      ...(fin.optimization ? { optimization: fin.optimization } : {}),
    });
  }

  if (cmd === "guidelines" && file) {
    let outArg: string | undefined;
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] === "--out" && outArg === undefined) {
        if (rest[i + 1] === undefined || rest[i + 1].startsWith("--"))
          return usageError("missing value after \"--out\"");
        outArg = rest[i + 1];
      } else return usageError("guidelines accepts at most one --out <path>");
    }
    const read = await readSceneFile(file);
    if ("errors" in read) return invalid(read.errors);
    const sceneDir = path.dirname(path.resolve(file));
    const result = await loadScene(sceneDir, library, read.raw);
    if (!result.ok) return invalid(result.errors);
    const output = outArg
      ? path.resolve(outArg)
      : path.join(sceneDir, "out", `${path.basename(path.resolve(file), ".json")}.guidelines.png`);
    if (outsideDir(sceneDir, output))
      return usageError(`--out "${outArg}" must stay inside the scene's directory (${sceneDir})`);
    // A guideline write must never target a final Render output: overwriting
    // the PNG would leave the recording manifest presenting guideline pixels
    // as an accepted Render. renderOutputConflict is the one reader for that
    // fact — a base render's manifest sits beside its output, but a Variant
    // batch shares one variants manifest naming every output, so every
    // manifest in the directory is consulted. That covers both collision
    // directions: a direct --out at a rendered PNG (base or batch) and a
    // default guideline name a render has claimed via --out.
    const conflict = await renderOutputConflict(output);
    if (conflict)
      return invalid([
        {
          path: "--out",
          message:
            `"${output}" is a Render output — the manifest "${path.basename(conflict.manifest)}" in the same directory ` +
            `records it, and the guideline view must never overwrite a final Render. Pick a different --out path.`,
        },
      ]);
    const { png, width, height } = await renderGuidelines(result.resolved);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, png);
    return ok({
      ok: true,
      output,
      width,
      height,
      regions: PROTECTED_REGIONS.map((r) => ({ id: r.id, label: r.label, box: r.box })),
    });
  }
  if (cmd === "guidelines") return usageError(`"scene guidelines" takes exactly one scene file`);

  if (cmd === "rerender" && file && rest.length === 0) return rerenderManifest(file, { library });
  if (cmd === "rerender")
    return usageError(`"scene rerender" takes exactly one manifest path`);

  if (cmd === "compare" && file) {
    if (rest.length) return usageError(`"scene compare" takes exactly one scene file and no options`);
    const read = await readSceneFile(file);
    if ("errors" in read) return invalid(read.errors);
    const sceneDir = path.dirname(path.resolve(file));
    // The one validation gate — every failure lands here, before any browser.
    const result = await loadScene(sceneDir, library, read.raw);
    if (!result.ok) return invalid(result.errors);
    // The reference gate: format, dimensions, containment. Compare is the one
    // command that needs the reference bytes, so the check runs here (and in
    // validate) — never in render, which does not read the reference.
    const ref = await checkReference(sceneDir, result.resolved.scene);
    if (!ref.ok) return invalid(ref.errors);
    if (!ref.reference)
      return invalid([
        {
          path: "reference",
          message:
            `this Scene has no associated Reference Thumbnail — set the "reference.path" field to a ` +
            `project-relative PNG at exactly 1280×720, e.g. { "reference": { "path": "reference.png" } }, to enable comparison.`,
        },
      ]);
    const base = path.basename(path.resolve(file), ".json");
    const outDir = path.join(sceneDir, "out");
    const renderPath = path.join(outDir, `${base}.compare.render.png`);
    const diffPath = path.join(outDir, `${base}.diff.png`);
    const sheetPath = path.join(outDir, `${base}.compare.html`);
    // The compare artifacts are review output, but a Render output recorded by
    // a manifest must never be overwritten by one — same rule as guidelines.
    for (const [p, what] of [
      [renderPath, "compare render"],
      [diffPath, "difference view"],
    ] as const) {
      const conflict = await renderOutputConflict(p);
      if (conflict)
        return invalid([
          {
            path: "compare",
            message:
              `the default ${what} path "${p}" is a Render output — the manifest "${path.basename(conflict.manifest)}" ` +
              `records it, and a review artifact must never overwrite a final Render. Rename the scene file or the recorded output.`,
          },
        ]);
    }
    const { png, width, height, warnings } = await renderScene(result.resolved);
    const diff = diffPng(png, ref.reference);
    await mkdir(outDir, { recursive: true });
    await writeFile(renderPath, png);
    await writeFile(diffPath, diff);
    await writeFile(
      sheetPath,
      renderCompareSheet({ scene: base, referencePath: ref.reference.path, renderPath, diffPath }),
    );
    return ok({
      ok: true,
      output: sheetPath,
      render: renderPath,
      diff: diffPath,
      reference: result.resolved.scene.reference!.path,
      width,
      height,
      warnings,
    });
  }
  if (cmd === "compare") return usageError(`"scene compare" takes exactly one scene file`);

  if (cmd === "reference" && file === "import") {
    const [sceneArg, inputArg, ...flags] = rest;
    if (!sceneArg || !inputArg)
      return usageError(`"scene reference import" takes exactly one scene file and one input image`);
    let source: string | undefined;
    for (let i = 0; i < flags.length; i += 2) {
      if (flags[i] === "--source" && source === undefined) {
        if (flags[i + 1] === undefined || flags[i + 1].startsWith("--"))
          return usageError(`missing value after "--source"`);
        source = flags[i + 1];
      } else
        return usageError(
          `"scene reference import" takes <scene> <file> and at most one --source <text>`,
        );
    }
    const result = await importReference(sceneArg, inputArg, {
      source,
      library,
      lockTimeoutMs: deps?.sceneLockTimeoutMs,
    });
    if (!result.ok) return invalid(result.errors);
    return ok({
      ok: true,
      scene: result.imported.sceneFile,
      reference: result.imported.reference,
      stored: result.imported.storedPath,
      normalized: result.imported.normalized,
    });
  }
  if (cmd === "reference")
    return usageError(`unknown reference command "${file ?? ""}" — expected "import <scene> <file>"`);

  return usageError(
    cmd === undefined
      ? "missing command — expected schema, themes, templates, init, inspect, validate, compare, render, guidelines, reference import, or rerender"
      : `unknown command "${cmd}" — expected schema, themes, templates, init, inspect, validate, compare, render, guidelines, reference import, or rerender`,
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
  opts?: { page?: Page; library?: () => Promise<Library> },
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
    const result = await loadScene(sceneDir, opts?.library ?? (() => scanLibrary(LIBRARY_ROOT)), doc, {
      // A manifest marked experimental recorded a legitimate non-final
      // render — rerender honors that; anything else hits the normal gate.
      allowTrialCreator: manifest.experimental === true,
    });
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
    // Named-mask identities verify exactly like layer assets (REQ-019): the
    // mask bytes a masked render used must still resolve to the same content.
    for (const [j, m] of (manifest.outputs[i]!.masks ?? []).entries()) {
      const resolved = result.resolved.masks.get(m.layer);
      if (!resolved)
        return invalid([
          {
            path: `outputs[${i}].masks[${j}].layer`,
            message: `layer "${m.layer}" is recorded with a mask in the manifest but has no resolved mask in this scene`,
          },
        ]);
      if (resolved.hash !== m.hash)
        return invalid([
          {
            path: `outputs[${i}].masks[${j}].hash`,
            message:
              `mask identity mismatch for layer "${m.layer}": the manifest recorded ${m.hash.slice(0, 12)}… ` +
              `but the mask now resolves to ${resolved.hash.slice(0, 12)}….\n` +
              `The mask content changed since the render — re-render normally to refresh the manifest.`,
          },
        ]);
    }
    // Rerender reports the same warnings a normal render of this scene would —
    // renderScene assembles the complete set, never the manifest's stale copy.
    // A render made under the trial-Creator override keeps its non-final
    // marker through the rerender (INT-2/PROD-2): the same trial assets are
    // still in the scene, so the same NON-FINAL warning is re-derived.
    const { png, width, height, warnings } = await renderScene(result.resolved, opts);
    const trialWarning = trialOverrideWarning(result.resolved);
    const marked = trialWarning ? [trialWarning] : [];
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
      warnings: [...warnings, ...marked],
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
    // A recorded experimental render stays marked through the rerender —
    // the rewritten output is non-final, like the original (INT-2/PROD-2).
    ...(manifest.experimental ? { experimental: true } : {}),
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
export async function run(
  args: string[],
  deps?: { libraryRoot?: string; sceneLockTimeoutMs?: number },
): Promise<CliResult> {
  const [cmd] = args;
  try {
    return await dispatch(args, deps);
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
