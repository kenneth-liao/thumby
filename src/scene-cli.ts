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
 * All operations are offline and local: loading, validating, inspecting, and
 * rendering never touch the network and never start a Generation Job.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIBRARY_ROOT, scanLibrary, type Library } from "./assets.js";
import { SCENE_SCHEMA, loadScene, SCHEMA_VERSION, type SceneError } from "./scene.js";
import { renderScene } from "./scene-render.js";
import { closeBrowser } from "./browser.js";

const HELP = `
thumby scene — versioned, locally rendered thumbnail compositions

  bun run scene schema                  Print the Scene JSON Schema document
  bun run scene inspect  <scene.json>   Structured layer summary (with resolved asset hashes)
  bun run scene validate <scene.json>   Validate: field-specific errors before any render
  bun run scene render   <scene.json>   Render to PNG (1280×720)

Options
  --out <path>   Render output path (default: out/<scene-basename>.png)

Output is JSON on stdout: { "ok": true, ... } or { "ok": false, "errors": [...] }.
Exit codes: 0 ok, 1 invalid scene or render failure, 2 usage error.
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

function summarizeLayer(layer: Record<string, unknown>): Record<string, unknown> {
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
  if (layer.type === "image") {
    summary.asset = layer.asset;
    if (layer.fit !== undefined) summary.fit = layer.fit;
    if (layer.crop !== undefined) summary.crop = layer.crop;
  } else {
    summary.text = layer.text;
    summary.font = layer.font;
    summary.fontSize = layer.fontSize;
    if (layer.color !== undefined) summary.color = layer.color;
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

export async function run(args: string[]): Promise<CliResult> {
  const [cmd, file, ...rest] = args;

  if (cmd === "schema" && file === undefined) return ok(SCENE_SCHEMA);
  if (cmd === "schema" && file) return usageError(`"scene schema" takes no arguments`);

  if ((cmd === "validate" || cmd === "inspect" || cmd === "render") && file) {
    if (cmd !== "render" && rest.length)
      return usageError(`unexpected arguments: ${rest.join(" ")}`);
    let outPath: string | undefined;
    if (cmd === "render") {
      if (rest.length === 2 && rest[0] === "--out") outPath = rest[1];
      else if (rest.length !== 0) return usageError("render accepts at most one --out <path>");
    }

    const lib = await scanLibrary(LIBRARY_ROOT);
    const read = await readSceneFile(file);
    if ("errors" in read) return invalid(read.errors);
    // The one validation gate — every failure lands here, before any browser.
    const result = await loadScene(path.dirname(path.resolve(file)), lib, read.raw);
    if (!result.ok) return invalid(result.errors);
    const { resolved } = result;

    if (cmd === "validate") {
      return ok({
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        layerCount: resolved.scene.layers.length,
      });
    }

    if (cmd === "inspect") {
      return ok({
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        canvas: resolved.scene.canvas,
        layerCount: resolved.scene.layers.length,
        layers: resolved.scene.layers.map((layer) => {
          const summary = summarizeLayer(layer as unknown as Record<string, unknown>);
          if (layer.type === "image") {
            summary.resolvedAsset = resolvedAssetSummary(resolved.assets.get(layer.id)!);
          }
          return summary;
        }),
      });
    }

    const sceneFile = path.resolve(file);
    const output =
      outPath ?? path.join("out", `${path.basename(sceneFile, ".json")}.png`);
    const { png, width, height } = await renderScene(resolved);
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, png);
    return ok({ ok: true, output, width, height });
  }

  return usageError(
    cmd === undefined
      ? "missing command — expected schema, inspect, validate, or render"
      : `unknown command "${cmd}" — expected schema, inspect, validate, or render`,
  );
}

if (import.meta.main) {
  const { exitCode, output } = await run(process.argv.slice(2));
  console.log(JSON.stringify(output, null, 2));
  await closeBrowser();
  process.exit(exitCode);
}
