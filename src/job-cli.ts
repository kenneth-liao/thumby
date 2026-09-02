#!/usr/bin/env bun
/**
 * The Generation Job CLI — the agent-facing interface to the Generation Job
 * lifecycle (REQ-013/REQ-014/REQ-015): typed request → candidates →
 * immutable Asset adoption.
 *
 * Same contract as the Scene CLI: every command prints machine-readable JSON
 * on stdout ({ok: true, ...} or {ok: false, errors: [...]}), exit codes
 * 0 ok / 1 failure / 2 usage error. run() is the error boundary — an
 * unexpected failure (gateway error, I/O) lands in the same structured shape.
 *
 * This is the only place that talks to the network: `jobs plates`, `jobs
 * objects`, and `jobs rerun` start Generation Jobs; every other command is
 * offline. Jobs live under <cwd>/out/jobs/<jobId>/ — the record (job.json),
 * content-addressed candidates, and the run lineage. Nothing here edits a
 * Scene or an existing asset; adoption goes through the kind's write path,
 * which cannot overwrite (and verifies true alpha for objects).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  parseTypedRef,
  runPlateJob,
  runObjectJob,
  runCreatorJob,
  rerunJob,
  lift,
  loadJob,
  listJobs,
  adoptCandidate,
  type PlateGenerator,
  type ObjectGenerator,
  type CreatorGenerator,
  type JobGenerator,
  type PlateJobRequest,
  type ObjectJobRequest,
  type CreatorJobRequest,
} from "./jobs.js";
import { generatePlates, generateObjects, generateCreators, type GenerateOptions } from "./generate.js";
import { localSegmentationMatteEngine } from "./segment.js";
import type { MatteEngine } from "./matte.js";
import type { TextZone } from "./generate.js";
import { DEFAULT_MODEL, CREATOR_DEFAULT_MODEL, MODELS } from "./models.js";
import { LIBRARY_ROOT } from "./assets.js";
import { reviewCreatorJob } from "./review.js";

const HELP = `
thumby jobs — the Generation Job lifecycle (request → candidates → adoption)

  bun run jobs plates <subject> [options]   Start a plate Generation Job
  bun run jobs objects <subject> [options]  Start an object Generation Job —
                                            one isolated non-text object
  bun run jobs creators <subject> [options] Start a creator Generation Job —
                                            an isolated creator candidate from
                                            typed identity anchors
  bun run jobs rerun <jobId>                Rerun a job's recorded request — appends
                                            candidates under the lineage, replaces nothing
  bun run jobs show <jobId>                 Full job record: request, typed references, runs
  bun run jobs list                         Summarize recorded jobs
  bun run jobs review <jobId>               Creator review: contact sheet + face-detail
                                            views against the identity anchors
                                            (writes <jobDir>/review.html, offline)
  bun run jobs adopt <jobId> <hash> --id <assetId>
                                            Adopt a candidate (exact hash or unique prefix)
                                            as a new immutable Asset of the job's kind.
                                            Adoption never overwrites an existing asset;
                                            an object or creator candidate with a matte is
                                            adopted as that matte (verified true alpha), one
                                            without is refused; creator adoption always enters
                                            the library as trial.

plates options
  --model <name>        Registry key or raw gateway id. Keys:
                        ${Object.keys(MODELS).join(" | ")}
                        (plates/objects default: ${DEFAULT_MODEL})
  --zone <z>            left (default) | right | bottom | none — the reserved text
                        region the plate must keep empty
  --count <n>           Candidates to generate (default 1)
  --temperature <t>     Multimodal models only
  --ref <role:path>     Typed reference with its content identity recorded, e.g.
                        --ref style:refs/palette.png (repeatable). A Job with
                        typed References requires a reference-capable model:
                        an incompatible selection — registry key or raw id —
                        is refused before any spend, listing every qualified
                        compatible model.
  --job <id>            Explicit job id (default: auto plate-<date>-<suffix>)

objects options
  Same as plates minus --zone. The subject must name an isolated non-text
  object — official logos and final text are rejected as targets (logos come
  from sourced Assets, text is rendered locally; ADR-0001). Every object
  candidate goes through the matting pass — the same local BiRefNet
  segmenter as creators (ADR-0006), local and unbilled — and adoption adopts
  that matte, since the models return opaque RGB. A natively isolated
  candidate is kept as-is. Adopted Object Assets carry a verified true-alpha
  matte; an opaque candidate with no matte is refused.

creators options
  Same as plates minus --zone. Requires at least one identity reference —
  a likeness is never generated from text alone. Accepted reference roles:
  identity (repeatable anchors), pose, expression, outfit, style, and edit
  (source-to-edit). Defaults to ${CREATOR_DEFAULT_MODEL}, the measured likeness workhorse.
  References are attached identity-anchors-first and pose-last; the run's
  fullPrompt role-assigns every reference, so the provenance preserves each
  declared role. Every candidate then goes through the matting pass — a local
  BiRefNet segmenter predicts the subject mask and it becomes the candidate's
  alpha channel, since the models return opaque RGB (ADR-0006) — and
  "jobs adopt" writes that matte, always as a trial Cutout Asset; approval is
  Kenneth's alone (DEC-004). The pass is local and unbilled: run cost is
  generation only. First use needs the pinned weights cached under models/ —
  a missing file fails loudly with the exact fetch command, before any
  generation is paid for. A candidate the pass could not isolate is refused
  at adoption and the run's warnings say why.

A plate is a full-canvas generated background whose contents are
intentionally flattened (ADR-0011). Your subject is authoritative: request
UI, products, devices, or any complex background element and the effective
prompt preserves it. Only final editorial text and exact logos stay local
(ADR-0001) — the prompt hard-bans text and logos.

Composability is an authoring policy, not a validation rule (DEC-013):
generate an element as its own Object Asset and Layer when movement,
resizing, recoloring, replacement, reuse, provenance, or Variants benefit
from separate control; keep environmental or tightly integrated detail
flattened in the plate when separate control adds nothing.

adopt options
  --id <assetId>        Library id for the adopted Asset (required)
  --name <str>          Display name (default: the id)
  --tags <csv>          Comma-separated tags

Every command prints JSON: { "ok": true, ... } or { "ok": false, "errors": [...]}.
Plate candidates are full-canvas flattened backgrounds (ADR-0011); final
text and exact logos are never generated — text renders locally and logos
are sourced Assets (ADR-0001). Object candidates are isolated non-text
Assets (REQ-015), never the final composite.
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

/**
 * The request→generatePlates mapping — the load-bearing wiring lives here:
 * the agent's subject is authoritative for the plate's visual content
 * (DEC-010, ADR-0011) and passes through untouched. Prompt construction adds
 * only format, zone, and invariant guidance — never a backdrop or content
 * ban. Final editorial text and exact logos stay local (ADR-0001).
 */
export function generateOptionsFor(request: PlateJobRequest): GenerateOptions {
  return {
    subject: request.subject,
    model: request.model,
    zone: request.zone,
    refs: request.refs.map((r) => r.path),
    count: request.count,
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
  };
}

/** The real generation paths: map the recorded request onto the AI SDK call. */
export const PRODUCTION_GENERATOR: PlateGenerator = async (request: PlateJobRequest) => {
  const result = await generatePlates(generateOptionsFor(request));
  return {
    candidates: result.plates.map((p) => ({ bytes: p.bytes, mediaType: p.mediaType })),
    warnings: result.warnings,
    fullPrompt: result.fullPrompt,
  };
};

/** The object request→generateObjects mapping (REQ-015). */
export const PRODUCTION_OBJECT_GENERATOR: ObjectGenerator = async (request: ObjectJobRequest) => {
  const result = await generateObjects({
    subject: request.subject,
    model: request.model,
    refs: request.refs.map((r) => r.path),
    count: request.count,
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
  });
  return {
    candidates: result.plates.map((p) => ({ bytes: p.bytes, mediaType: p.mediaType })),
    warnings: result.warnings,
    fullPrompt: result.fullPrompt,
  };
};

/** The creator request→generateCreators mapping (REQ-017). */
export const PRODUCTION_CREATOR_GENERATOR: CreatorGenerator = async (request: CreatorJobRequest) => {
  const result = await generateCreators({
    subject: request.subject,
    model: request.model,
    // Recorded identities travel with the request: generation verifies the
    // bytes against them before anything is sent to the model.
    refs: request.refs.map((r) => ({ role: r.role, path: r.path, contentHash: r.contentHash })),
    count: request.count,
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
  });
  return {
    candidates: result.plates.map((p) => ({ bytes: p.bytes, mediaType: p.mediaType })),
    warnings: result.warnings,
    fullPrompt: result.fullPrompt,
  };
};

/**
 * The shipped matting pass (REQ-017, ADR-0006): a BiRefNet segmenter running
 * locally predicts the subject mask, applied as a true alpha channel. It runs
 * on every creator candidate the model does not already return isolated,
 * which — measured — is all of them. Nothing leaves the machine, and nothing
 * is billed.
 */
export const PRODUCTION_MATTE_ENGINE: MatteEngine = localSegmentationMatteEngine();

export interface JobCliDeps {
  generate: PlateGenerator;
  generateObject: ObjectGenerator;
  generateCreator: CreatorGenerator;
  /** The matting pass creator and object candidates are isolated with before they can be adopted. */
  matte: MatteEngine;
  /** Where job records live (default: <cwd>/out/jobs). */
  jobsRoot: string;
  /** Library root for adoption (default: the repo asset library). */
  libraryRoot: string;
}

const ZONES: TextZone[] = ["left", "right", "bottom", "none"];

function autoJobId(kind: "plate" | "object" | "creator"): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${kind}-${day}-${suffix}`;
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

/** Flags shared by every job-starting command (model, count, refs, job id). */
async function collectGenerationFlags(
  rest: string[],
  usage: (message: string) => CliResult,
  opts?: { extraFlags?: string[] },
): Promise<{ fields: {
    model: string;
    count: number;
    temperature?: number;
    refs: Awaited<ReturnType<typeof parseTypedRef>>[];
    jobId: string;
    extra: Map<string, string | string[] | true>;
  } } | { error: CliResult }> {
  const allowed = ["model", "count", "temperature", "ref", "job", ...(opts?.extraFlags ?? [])];
  const parsed = parseFlags(rest, [], allowed, ["ref"]);
  if ("error" in parsed) return { error: usage(`unexpected argument "${parsed.error}"`) };
  const flags = parsed.flags;

  const model = (flags.get("model") as string) ?? DEFAULT_MODEL;

  let count = 1;
  if (flags.has("count")) {
    count = Number(flags.get("count"));
    if (!Number.isInteger(count) || count < 1 || count > 8)
      return { error: usage("--count must be an integer between 1 and 8") };
  }

  let temperature: number | undefined;
  if (flags.has("temperature")) {
    temperature = Number(flags.get("temperature"));
    if (!Number.isFinite(temperature))
      return { error: usage("--temperature must be a number") };
  }

  const refs: Awaited<ReturnType<typeof parseTypedRef>>[] = [];
  for (const spec of (flags.get("ref") as string[] | undefined) ?? []) {
    try {
      refs.push(await parseTypedRef(spec));
    } catch (err) {
      return { error: usage((err as Error).message) };
    }
  }

  return {
    fields: {
      model,
      count,
      ...(temperature !== undefined ? { temperature } : {}),
      refs,
      jobId: (flags.get("job") as string | undefined) ?? "",
      extra: flags,
    },
  };
}

async function platesCommand(
  deps: JobCliDeps,
  subject: string | undefined,
  rest: string[],
): Promise<CliResult> {
  if (!subject?.trim()) return usageError('"jobs plates" needs a subject describing the background');
  const collected = await collectGenerationFlags(rest, usageError, { extraFlags: ["zone"] });
  if ("error" in collected) return collected.error;

  // --zone is plate-only: objects have no reserved text region.
  const zone = (collected.fields.extra.get("zone") ?? "left") as TextZone;
  if (!ZONES.includes(zone)) return usageError(`--zone must be one of ${ZONES.join(" | ")}`);

  return startJob(deps, "plate", subject, { ...collected.fields, zone });
}

async function objectsCommand(
  deps: JobCliDeps,
  subject: string | undefined,
  rest: string[],
): Promise<CliResult> {
  if (!subject?.trim())
    return usageError('"jobs objects" needs a subject naming the object to generate');
  const collected = await collectGenerationFlags(rest, usageError);
  if ("error" in collected) return collected.error;
  return startJob(deps, "object", subject, { ...collected.fields });
}

async function creatorsCommand(
  deps: JobCliDeps,
  subject: string | undefined,
  rest: string[],
): Promise<CliResult> {
  if (!subject?.trim())
    return usageError(
      '"jobs creators" needs a subject describing the pose, expression, outfit, or edit — and at least one --ref identity:<file>',
    );
  const collected = await collectGenerationFlags(rest, usageError);
  if ("error" in collected) return collected.error;
  // Creator jobs default to the measured likeness workhorse — gpt-image is
  // reference-capable now (#52), but its likeness strength is not qualified
  // (TEST-012), so the default stays a deliberate likeness choice, not a
  // capability derivation. An explicit --model is honored as written: only
  // capability is gated (the job request boundary refuses an unqualified
  // model before any spend); likeness quality is the agent's judgment.
  const fields = collected.fields;
  if (!fields.extra.has("model")) fields.model = CREATOR_DEFAULT_MODEL;
  return startJob(deps, "creator", subject, { ...fields });
}

/** Build the request, run the job, and print the run record. */
async function startJob(
  deps: JobCliDeps,
  kind: "plate" | "object" | "creator",
  subject: string,
  fields: {
    model: string;
    count: number;
    temperature?: number;
    refs: Awaited<ReturnType<typeof parseTypedRef>>[];
    jobId: string;
    zone?: TextZone;
  },
): Promise<CliResult> {
  const jobId = fields.jobId || autoJobId(kind);
  const common = {
    subject,
    model: fields.model,
    count: fields.count,
    ...(fields.temperature !== undefined ? { temperature: fields.temperature } : {}),
    refs: fields.refs,
  };
  const job =
    kind === "plate"
      ? await runPlateJob(deps.jobsRoot, jobId, { kind, zone: fields.zone ?? "left", ...common }, deps.generate)
      : kind === "object"
        ? await runObjectJob(deps.jobsRoot, jobId, { kind, ...common }, deps.generateObject, deps.matte)
        : await runCreatorJob(deps.jobsRoot, jobId, { kind, ...common }, deps.generateCreator, deps.matte);
  const runIndex = job.runs.length - 1;
  return ok({
    ok: true,
    jobId: job.jobId,
    kind: job.kind,
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
  if (!assetId) return usageError("adopt requires --id <assetId> for the new Asset");
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

  if (cmd === "plates")
    return platesCommand(deps, first, [second, ...rest].filter((a) => a !== undefined));

  if (cmd === "objects")
    return objectsCommand(deps, first, [second, ...rest].filter((a) => a !== undefined));

  if (cmd === "creators")
    return creatorsCommand(deps, first, [second, ...rest].filter((a) => a !== undefined));

  if (cmd === "rerun") {
    if (!first || second !== undefined) return usageError('"jobs rerun" takes exactly one <jobId>');
    // The generator follows the loaded job's kind — a recorded lineage is
    // always rerun with the request contract it was created under, and a
    // lifted generator refuses the other kind outright.
    const recorded = await loadJob(deps.jobsRoot, first);
    const generator: JobGenerator =
      recorded.request.kind === "object"
        ? lift("object", deps.generateObject)
        : recorded.request.kind === "creator"
          ? lift("creator", deps.generateCreator)
          : lift("plate", deps.generate);
    const job = await rerunJob(
      deps.jobsRoot,
      first,
      generator,
      // recordRun is the single reader of which kinds are matted; the pass is
      // inert for plates, so the engine is handed over unconditionally.
      deps.matte,
    );
    const runIndex = job.runs.length - 1;
    return ok({
      ok: true,
      jobId: job.jobId,
      kind: job.kind,
      jobDir: path.join(deps.jobsRoot, job.jobId),
      runIndex,
      run: job.runs[runIndex],
      job,
    });
  }

  if (cmd === "show") {
    if (!first || second !== undefined) return usageError('"jobs show" takes exactly one <jobId>');
    const job = await loadJob(deps.jobsRoot, first);
    return ok({ ok: true, job });
  }

  if (cmd === "list") {
    if (first) return usageError('"jobs list" takes no arguments');
    return ok({ ok: true, jobs: await listJobs(deps.jobsRoot) });
  }

  if (cmd === "review") {
    if (!first || second !== undefined) return usageError('"jobs review" takes exactly one <jobId>');
    const review = await reviewCreatorJob(deps.jobsRoot, first);
    return ok({
      ok: true,
      jobId: review.jobId,
      review: review.reviewPath,
      candidates: review.candidates.map((c) => ({
        contentHash: c.contentHash,
        runIndex: c.runIndex,
        file: c.file,
      })),
      anchors: review.anchors.map((a) => ({ id: a.id, path: a.path })),
    });
  }

  if (cmd === "adopt") return adoptCommand(deps, first, second, rest);

  return usageError(
    cmd === undefined
      ? "missing command — expected plates, objects, creators, rerun, show, list, review, or adopt"
      : `unknown command "${cmd}" — expected plates, objects, creators, rerun, show, list, review, or adopt`,
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
    generateObject: deps?.generateObject ?? PRODUCTION_OBJECT_GENERATOR,
    generateCreator: deps?.generateCreator ?? PRODUCTION_CREATOR_GENERATOR,
    matte: deps?.matte ?? PRODUCTION_MATTE_ENGINE,
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
