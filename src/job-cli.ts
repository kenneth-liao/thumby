#!/usr/bin/env bun
/**
 * The Generation Job CLI — the agent-facing interface to the Generation Job
 * lifecycle (REQ-013/REQ-014): typed request → candidates → immutable Asset
 * adoption.
 *
 * Same contract as the Scene CLI: every command prints machine-readable JSON
 * on stdout ({ok: true, ...} or {ok: false, errors: [...]}), exit codes
 * 0 ok / 1 failure / 2 usage error. run() is the error boundary — an
 * unexpected failure (gateway error, I/O) lands in the same structured shape.
 *
 * This is the only place that talks to the network: `jobs plates` and
 * `jobs rerun` start Generation Jobs; every other command is offline. Jobs
 * live under <cwd>/out/jobs/<jobId>/ — the record (job.json), content-addressed
 * candidates, and the run lineage. Nothing here edits a Scene or an existing
 * asset; adoption goes through writePlateAsset, which cannot overwrite.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  parseTypedRef,
  runPlateJob,
  rerunPlateJob,
  loadJob,
  listJobs,
  adoptCandidate,
  type PlateGenerator,
  type PlateJobRequest,
} from "./jobs.js";
import { generatePlates } from "./generate.js";
import type { TextZone } from "./generate.js";
import { DEFAULT_MODEL } from "./models.js";
import { LIBRARY_ROOT } from "./assets.js";

const HELP = `
thumby jobs — the Generation Job lifecycle (request → candidates → adoption)

  bun run jobs plates <subject> [options]   Start a plate Generation Job
  bun run jobs rerun <jobId>                Rerun a job's recorded request — appends
                                            candidates under the lineage, replaces nothing
  bun run jobs show <jobId>                 Full job record: request, typed references, runs
  bun run jobs list                         Summarize recorded jobs
  bun run jobs adopt <jobId> <hash> --id <assetId>
                                            Adopt a candidate (exact hash or unique prefix)
                                            as a new immutable Plate Asset. Adoption never
                                            overwrites an existing asset.

plates options
  --model <name>        gpt-image (default) | nano-lite | nano-2 | nano-pro | flux |
                        seedream | recraft | raw gateway id
  --zone <z>            left (default) | right | bottom | none — the reserved text
                        region the plate must keep empty
  --count <n>           Candidates to generate (default 1)
  --temperature <t>     Multimodal models only
  --ref <role:path>     Typed reference with its content identity recorded, e.g.
                        --ref style:refs/palette.png (repeatable)
  --job <id>            Explicit job id (default: auto plate-<date>-<suffix>)

A plate job is a bare backdrop by definition (REQ-014): no person, product,
device, or independently editable foreground object is baked in — subjects
enter Scenes as their own layers, never inside the plate.

adopt options
  --id <assetId>        Library id for the adopted Plate Asset (required)
  --name <str>          Display name (default: the id)
  --tags <csv>          Comma-separated tags

Every command prints JSON: { "ok": true, ... } or { "ok": false, "errors": [...] }.
Plate candidates are background ambience only — final text, logos, and
independently editable foreground elements are excluded by the plate request
contract and rendered locally (ADR-0001, DEC-005, DEC-006).
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
const failure = (message: string, path = "jobs"): CliResult => ({
  exitCode: 1,
  output: { ok: false, errors: [{ path, message }] },
});

/** The real generation path: map the recorded request onto the AI SDK call. */
export const PRODUCTION_GENERATOR: PlateGenerator = async (request: PlateJobRequest) => {
  const result = await generatePlates({
    subject: request.subject,
    model: request.model,
    zone: request.zone,
    refs: request.refs.map((r) => r.path),
    count: request.count,
    // A Plate Job is a bare backdrop by definition (REQ-014): no person,
    // product, device, or independently editable foreground object baked in.
    subjectless: true,
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
  });
  return {
    plates: result.plates.map((p) => ({ bytes: p.bytes, mediaType: p.mediaType })),
    warnings: result.warnings,
    fullPrompt: result.fullPrompt,
  };
};

export interface JobCliDeps {
  generate: PlateGenerator;
  /** Where job records live (default: <cwd>/out/jobs). */
  jobsRoot: string;
  /** Library root for adoption (default: the repo asset library). */
  libraryRoot: string;
}

const ZONES: TextZone[] = ["left", "right", "bottom", "none"];

function autoJobId(): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `plate-${day}-${suffix}`;
}

/**
 * Collect "--flag value" / "--boolean" pairs. Names in `multiple` accumulate
 * every occurrence into an array; the rest keep their last value. Usage errors
 * carry the offending argument — errors identify the invalid field (REQ-013).
 */
function parseFlags(
  rest: string[],
  booleans: string[],
  allowed: string[],
  multiple: string[] = [],
): { flags: Map<string, string | string[] | true> } | { error: string } {
  const flags = new Map<string, string | string[] | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) return { error: arg };
    const name = arg.slice(2);
    if (!allowed.includes(name)) return { error: arg };
    if (booleans.includes(name)) {
      flags.set(name, true);
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) return { error: arg };
    if (multiple.includes(name)) {
      const prior = flags.get(name);
      flags.set(name, Array.isArray(prior) ? [...prior, value] : [value]);
    } else flags.set(name, value);
  }
  return { flags };
}

async function platesCommand(
  deps: JobCliDeps,
  subject: string | undefined,
  rest: string[],
): Promise<CliResult> {
  if (!subject?.trim()) return usageError('"jobs plates" needs a subject describing the background');
  const parsed = parseFlags(rest, [], [
    "model", "zone", "count", "temperature", "ref", "job",
  ], ["ref"]);
  if ("error" in parsed) return usageError(`unexpected argument "${parsed.error}"`);
  const flags = parsed.flags;

  const zone = (flags.get("zone") ?? "left") as TextZone;
  if (!ZONES.includes(zone)) return usageError(`--zone must be one of ${ZONES.join(" | ")}`);
  const model = (flags.get("model") as string) ?? DEFAULT_MODEL;

  let count = 1;
  if (flags.has("count")) {
    count = Number(flags.get("count"));
    if (!Number.isInteger(count) || count < 1 || count > 8)
      return usageError("--count must be an integer between 1 and 8");
  }

  let temperature: number | undefined;
  if (flags.has("temperature")) {
    temperature = Number(flags.get("temperature"));
    if (!Number.isFinite(temperature))
      return usageError("--temperature must be a number");
  }

  const refs: Awaited<ReturnType<typeof parseTypedRef>>[] = [];
  for (const spec of (flags.get("ref") as string[] | undefined) ?? []) {
    try {
      refs.push(await parseTypedRef(spec));
    } catch (err) {
      return usageError((err as Error).message);
    }
  }

  const jobId = (flags.get("job") as string | undefined) ?? autoJobId();
  const request: PlateJobRequest = {
    kind: "plate",
    subject,
    zone,
    model,
    count,
    ...(temperature !== undefined ? { temperature } : {}),
    refs,
  };
  const job = await runPlateJob(deps.jobsRoot, jobId, request, deps.generate);
  const runIndex = job.runs.length - 1;
  return ok({
    ok: true,
    jobId: job.jobId,
    jobDir: path.join(deps.jobsRoot, job.jobId),
    runIndex,
    run: job.runs[runIndex],
  });
}

async function adoptCommand(
  deps: JobCliDeps,
  jobId: string | undefined,
  candidateRef: string | undefined,
  rest: string[],
): Promise<CliResult> {
  if (!jobId || !candidateRef)
    return usageError("adopt needs a <jobId> and a candidate hash (see `jobs show <jobId>`)");
  const parsed = parseFlags(rest, [], ["id", "name", "tags"]);
  if ("error" in parsed) return usageError(`unexpected argument "${parsed.error}"`);
  const assetId = parsed.flags.get("id") as string | undefined;
  if (!assetId) return usageError("adopt requires --id <assetId> for the new Plate Asset");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(assetId))
    return usageError(`--id must be lowercase letters/digits/hyphens (got "${assetId}")`);

  const result = await adoptCandidate(deps.jobsRoot, jobId, candidateRef, assetId, {
    libraryRoot: deps.libraryRoot,
    ...(parsed.flags.has("name") ? { name: parsed.flags.get("name") as string } : {}),
    ...(parsed.flags.has("tags")
      ? {
          tags: (parsed.flags.get("tags") as string)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }
      : {}),
  });
  return ok({ ok: true, ...result, libraryPath: result.imagePath });
}

async function dispatch(args: string[], deps: JobCliDeps): Promise<CliResult> {
  const [cmd, first, second, ...rest] = args;

  if (cmd === "plates") return platesCommand(deps, first, [second, ...rest].filter((a) => a !== undefined));

  if (cmd === "rerun") {
    if (!first || rest.length) return usageError('"jobs rerun" takes exactly one <jobId>');
    const job = await rerunPlateJob(deps.jobsRoot, first, deps.generate);
    const runIndex = job.runs.length - 1;
    return ok({
      ok: true,
      jobId: job.jobId,
      jobDir: path.join(deps.jobsRoot, job.jobId),
      runIndex,
      run: job.runs[runIndex],
      job,
    });
  }

  if (cmd === "show") {
    if (!first || rest.length) return usageError('"jobs show" takes exactly one <jobId>');
    const job = await loadJob(deps.jobsRoot, first);
    return ok({ ok: true, job });
  }

  if (cmd === "list") {
    if (first) return usageError('"jobs list" takes no arguments');
    return ok({ ok: true, jobs: await listJobs(deps.jobsRoot) });
  }

  if (cmd === "adopt") return adoptCommand(deps, first, second, rest);

  return usageError(
    cmd === undefined
      ? "missing command — expected plates, rerun, show, list, or adopt"
      : `unknown command "${cmd}" — expected plates, rerun, show, list, or adopt`,
  );
}

/**
 * The error boundary: a gateway failure, I/O error, or refused adoption is
 * structured JSON like any other result — never a raw stack trace.
 */
export async function run(
  args: string[],
  deps?: Partial<JobCliDeps>,
): Promise<CliResult> {
  const resolved: JobCliDeps = {
    generate: deps?.generate ?? PRODUCTION_GENERATOR,
    jobsRoot: deps?.jobsRoot ?? path.resolve("out", "jobs"),
    libraryRoot: deps?.libraryRoot ?? LIBRARY_ROOT,
  };
  const [cmd] = args;
  try {
    await mkdir(resolved.jobsRoot, { recursive: true });
    return await dispatch(args, resolved);
  } catch (err) {
    return failure((err as Error).message || String(err), cmd ?? "jobs");
  }
}

if (import.meta.main) {
  const { exitCode, output } = await run(process.argv.slice(2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(exitCode);
}
