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
import { SCENE_SCHEMA, loadScene, SCHEMA_VERSION, type SceneError } from "./scene.js";
import { renderScene, layerTree } from "./scene-render.js";
import { closeBrowser } from "./browser.js";

const HELP = `
thumby scene — versioned, locally rendered thumbnail compositions

  bun run scene schema                  Print the Scene JSON Schema document
  bun run scene inspect  <scene.json>   Structured layer summary (with resolved asset hashes)
  bun run scene validate <scene.json>   Validate: field-specific errors before any render
  bun run scene render   <scene.json>   Render to PNG (1280×720)

Options
  --out <path>   Render output path inside the scene's directory
                 (default: <scene-dir>/out/<scene-basename>.png)

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
  const summary: Record<string, unknown> = {
    id: layer.id,
    type: layer.type,
    visible: layer.visible ?? true,
    opacity: layer.opacity ?? 1,
    position: layer.position,
    size: layer.size,
  };
  if (layer.rotation !== undefined) summary.rotation = layer.rotation;
  if (layer.mirror !== undefined) summary.mirror = layer.mirror;
  if (layer.effects !== undefined) summary.effects = layer.effects;
  if (layer.type === "image") {
    summary.asset = layer.asset;
    if (layer.fit !== undefined) summary.fit = layer.fit;
    if (layer.crop !== undefined) summary.crop = layer.crop;
    const resolved = assets?.get(layer.id as string);
    if (resolved) summary.resolvedAsset = resolvedAssetSummary(resolved);
  } else if (layer.type === "shape") {
    summary.shape = layer.shape;
    if (layer.radius !== undefined) summary.radius = layer.radius;
    if (layer.color !== undefined) summary.color = layer.color;
    if (layer.fill !== undefined) summary.fill = layer.fill;
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
    if (layer.weight !== undefined) summary.weight = layer.weight;
    if (layer.tracking !== undefined) summary.tracking = layer.tracking;
    if (layer.casing !== undefined) summary.casing = layer.casing;
    if (layer.color !== undefined) summary.color = layer.color;
    if (layer.fill !== undefined) summary.fill = layer.fill;
    if (layer.stroke !== undefined) summary.stroke = layer.stroke;
    if (layer.shadows !== undefined) summary.shadows = layer.shadows;
    if (layer.align !== undefined) summary.align = layer.align;
    if (layer.lineHeight !== undefined) summary.lineHeight = layer.lineHeight;
  }
  return summary;
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
        layerCount: [...layerTree(resolved.scene.layers)].length,
      });
    }

    if (cmd === "inspect") {
      return ok({
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        canvas: resolved.scene.canvas,
        layerCount: [...layerTree(resolved.scene.layers)].length,
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
      ? "missing command — expected schema, inspect, validate, or render"
      : `unknown command "${cmd}" — expected schema, inspect, validate, or render`,
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
