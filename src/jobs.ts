/**
 * Generation Jobs (REQ-013/REQ-014) — the lifecycle from typed request
 * through candidates to immutable Asset adoption.
 *
 * A job is one directory under the jobs root (`out/jobs/<jobId>/`):
 *   job.json                 — the record: request, typed references, run lineage
 *   candidates/<sha-256>.png — content-addressed candidate bytes
 *
 * Every rerun appends a new run to `job.json` and never touches prior runs or
 * candidates. Adoption copies a candidate into the asset library through the
 * normal contract; it can never overwrite an existing asset (see
 * `writePlateAsset` in assets.ts). Jobs never edit Scenes or unrelated assets.
 */
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { TextZone } from "./generate.js";
import { resolveModel } from "./models.js";
import { extensionFor, writePlateAsset, writeObjectAsset } from "./assets.js";
import { verifyTrueAlpha } from "./alpha.js";

/**
 * Job record schema versions. v1 is plate-only; object-capable jobs are v2.
 * The bump is the rollback boundary: a 0.15.1 binary rejects a v2 record
 * outright instead of rerunning or adopting an object job through its
 * plate-only path (where no alpha gate exists).
 */
export const PLATE_JOB_SCHEMA_VERSION = 1 as const;
export const OBJECT_JOB_SCHEMA_VERSION = 2 as const;

/** A generation reference with an explicit role and exact content identity. */
export interface TypedRef {
  role: string;
  path: string;
  /** sha-256 of the reference bytes, derived when the request was made. */
  contentHash: string;
}

export interface PlateJobRequest {
  kind: "plate";
  subject: string;
  zone: TextZone;
  model: string;
  count: number;
  temperature?: number;
  refs: TypedRef[];
}

/**
 * An isolated non-text object request (REQ-015): one standalone object, no
 * scene, no composite. Official logos and final text are rejected as targets
 * at the request boundary — `validateObjectSubject`.
 */
export interface ObjectJobRequest {
  kind: "object";
  subject: string;
  model: string;
  count: number;
  temperature?: number;
  refs: TypedRef[];
}

export type JobRequest = PlateJobRequest | ObjectJobRequest;

export interface JobCandidate {
  contentHash: string;
  /** Path relative to the job directory. */
  file: string;
  mediaType: string;
}

export interface JobRun {
  ranAt: string;
  /** The resolved gateway model id actually called. */
  model: string;
  /** The full text sent to the model, composition suffix included. */
  fullPrompt: string;
  costUsd: number;
  costMeasured: boolean;
  warnings: string[];
  candidates: JobCandidate[];
}

export interface GenerationJob {
  schemaVersion: typeof PLATE_JOB_SCHEMA_VERSION | typeof OBJECT_JOB_SCHEMA_VERSION;
  jobId: string;
  kind: "plate" | "object";
  createdAt: string;
  request: JobRequest;
  runs: JobRun[];
}

export interface JobSummary {
  jobId: string;
  kind: "plate" | "object";
  subject: string;
  createdAt: string;
  runs: number;
  candidates: number;
}

/** The injectable generation seam — the AI SDK boundary lives behind this. */
export interface GeneratedBatch {
  candidates: { bytes: Uint8Array; mediaType: string }[];
  warnings: string[];
  fullPrompt: string;
}
export type PlateGenerator = (request: PlateJobRequest) => Promise<GeneratedBatch>;
export type ObjectGenerator = (request: ObjectJobRequest) => Promise<GeneratedBatch>;
export type JobGenerator = (request: JobRequest) => Promise<GeneratedBatch>;

/**
 * Subjects that ask the model to paint an official logo or readable text are
 * rejected before any generation call: logos come from sourced Assets
 * (`library add-logo`) and final text is rendered locally (ADR-0001,
 * DEC-005/DEC-006). The guard is a deterministic denylist — it errs toward
 * refusing, and a refused subject can always be reworded to name the object
 * itself rather than its lettering.
 */
const OBJECT_SUBJECT_BAN =
  /\b(logos?|logotypes?|logomarks?|wordmarks?|brand ?marks?|trademarks?|text|headline|headlines|title|subtitle|captions?|lettering|typography|letters?|words?|watermarks?|slogans?|taglines?|numbers?|fonts?)\b/i;

export function validateObjectSubject(subject: string): void {
  if (!subject.trim()) throw new Error(`An object job needs a subject naming the object to generate`);
  const hit = OBJECT_SUBJECT_BAN.exec(subject);
  if (hit)
    throw new Error(
      `"${subject}" asks for ${hit[0]} — object generation targets must be isolated non-text objects. ` +
        `Official logos come from sourced Assets (bun run library add-logo) and final text is rendered locally (ADR-0001); ` +
        `reword the subject to name the object itself, not its lettering.`,
    );
}

const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;

function jobDir(jobRoot: string, jobId: string): string {
  return path.join(jobRoot, jobId);
}

async function writeJobRecord(jobRoot: string, job: GenerationJob): Promise<void> {
  await writeFile(
    path.join(jobDir(jobRoot, job.jobId), "job.json"),
    JSON.stringify(job, null, 2) + "\n",
  );
}

/**
 * Parse "<role>:<path>" and derive the reference's exact content identity
 * from its bytes at request time. The role is a typed token — an untyped
 * path-only reference is rejected.
 */
export async function parseTypedRef(spec: string): Promise<TypedRef> {
  const sep = spec.indexOf(":");
  if (sep < 0) throw new Error(`Reference "${spec}" must be typed as "<role>:<path>" (e.g. style:<path>)`);
  const role = spec.slice(0, sep);
  const p = spec.slice(sep + 1);
  if (!ROLE_PATTERN.test(role))
    throw new Error(`Reference role "${role}" must be lowercase letters/digits/hyphens (got in "${spec}")`);
  if (!p) throw new Error(`Reference "${spec}" is missing a path after the role`);
  const bytes = await readFile(path.resolve(p));
  return { role, path: p, contentHash: sha256(bytes) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Adapt a kind-specific generator to the joint seam, refusing to run a
 * request of the other kind — a plate generator must never execute an object
 * request (their prompts and contracts differ).
 */
/** Wrap a kind-specific generator as a JobGenerator that refuses other kinds. */
export function lift<K extends JobRequest["kind"]>(
  kind: K,
  generate: (request: Extract<JobRequest, { kind: K }>) => Promise<GeneratedBatch>,
): JobGenerator {
  return (request) => {
    if (request.kind !== kind)
      throw new Error(`a ${kind} generator cannot run a "${request.kind}" job request`);
    return generate(request as Extract<JobRequest, { kind: K }>);
  };
}

/**
 * Execute a request as a new Generation Job and record the run.
 * Creating over an existing job id is refused — rerun is the only
 * way to add candidates, so a lineage can never be silently mixed.
 */
async function runJob(
  jobRoot: string,
  jobId: string,
  request: JobRequest,
  generate: JobGenerator,
): Promise<GenerationJob> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  if (existsSync(path.join(jobRoot, jobId, "job.json")))
    throw new Error(`Job "${jobId}" already exists — use "jobs rerun ${jobId}" to add candidates under its lineage`);

  const batch = await generate(request);
  const now = new Date().toISOString();
  const job: GenerationJob = {
    schemaVersion: request.kind === "object" ? OBJECT_JOB_SCHEMA_VERSION : PLATE_JOB_SCHEMA_VERSION,
    jobId,
    kind: request.kind,
    createdAt: now,
    request,
    runs: [],
  };
  const run = await recordRun(jobRoot, job, request, batch, now);
  job.runs.push(run);
  await writeJobRecord(jobRoot, job);
  return job;
}

export function runPlateJob(
  jobRoot: string,
  jobId: string,
  request: PlateJobRequest,
  generate: PlateGenerator,
): Promise<GenerationJob> {
  return runJob(jobRoot, jobId, request, lift("plate", generate));
}

export async function runObjectJob(
  jobRoot: string,
  jobId: string,
  request: ObjectJobRequest,
  generate: ObjectGenerator,
): Promise<GenerationJob> {
  validateObjectSubject(request.subject);
  return runJob(jobRoot, jobId, request, lift("object", generate));
}

/**
 * Re-execute a job's recorded request and append the run to its lineage.
 * Reference identities are re-derived and compared first — drifted or
 * missing references fail loudly, because a rerun with different reference
 * content would be a different job wearing the same id.
 */
export async function rerunJob(
  jobRoot: string,
  jobId: string,
  generate: JobGenerator,
): Promise<GenerationJob> {
  const job = await loadJob(jobRoot, jobId);
  for (const ref of job.request.refs) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.resolve(ref.path));
    } catch {
      throw new Error(`Reference "${ref.path}" (role ${ref.role}) is missing — cannot rerun job "${jobId}"`);
    }
    const actual = sha256(bytes);
    if (actual !== ref.contentHash)
      throw new Error(
        `Reference "${ref.path}" (role ${ref.role}) changed content identity — recorded sha-256 ${ref.contentHash}, actual ${actual}. Record a new job for different references.`,
      );
  }

  const batch = await generate(job.request);
  const run = await recordRun(jobRoot, job, job.request, batch, new Date().toISOString());
  job.runs.push(run);
  await writeJobRecord(jobRoot, job);
  return job;
}

export function rerunPlateJob(
  jobRoot: string,
  jobId: string,
  generate: PlateGenerator,
): Promise<GenerationJob> {
  return rerunJob(jobRoot, jobId, lift("plate", generate));
}

export function rerunObjectJob(
  jobRoot: string,
  jobId: string,
  generate: ObjectGenerator,
): Promise<GenerationJob> {
  return rerunJob(jobRoot, jobId, lift("object", generate));
}

/** Call the generator, persist the candidates, and build the run record. */
async function recordRun(
  jobRoot: string,
  job: GenerationJob,
  request: JobRequest,
  batch: GeneratedBatch,
  ranAt: string,
): Promise<JobRun> {
  if (batch.candidates.length === 0) throw new Error("Generation returned no candidates");
  const spec = resolveModel(request.model);
  const dir = jobDir(jobRoot, job.jobId);
  const candidatesDir = path.join(dir, "candidates");
  await mkdir(candidatesDir, { recursive: true });

  const candidates: JobCandidate[] = [];
  for (const candidate of batch.candidates) {
    const contentHash = sha256(candidate.bytes);
    const file = path.join("candidates", `${contentHash}.${extensionFor(candidate.mediaType)}`);
    await writeFile(path.join(dir, file), candidate.bytes);
    candidates.push({ contentHash, file, mediaType: candidate.mediaType });
  }

  return {
    ranAt,
    model: spec.id,
    fullPrompt: batch.fullPrompt,
    costUsd: spec.approxCost * batch.candidates.length,
    costMeasured: spec.costMeasured,
    warnings: batch.warnings,
    candidates,
  };
}

/**
 * Load a job record; missing, corrupt, or contradictory records fail loudly.
 * The record's `kind` mirrors `request.kind`, but a hand-edited or tampered
 * file could disagree — rerun dispatches on the request and adoption on the
 * record, so an unvalidated contradiction would let one job rerun under one
 * contract and adopt under another (bypassing the object alpha gate). Both
 * are validated equal here, the single ingestion point, and v1 records are
 * pinned to plate jobs (v2 introduced object jobs).
 */
export async function loadJob(jobRoot: string, jobId: string): Promise<GenerationJob> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  let raw: string;
  try {
    raw = await readFile(path.join(jobRoot, jobId, "job.json"), "utf8");
  } catch {
    throw new Error(`No generation job "${jobId}" under ${jobRoot}`);
  }
  try {
    const job = JSON.parse(raw) as GenerationJob;
    if (job.schemaVersion !== PLATE_JOB_SCHEMA_VERSION && job.schemaVersion !== OBJECT_JOB_SCHEMA_VERSION)
      throw new Error(
        `unsupported job schemaVersion ${JSON.stringify(job.schemaVersion)} — this tool reads versions ${PLATE_JOB_SCHEMA_VERSION} and ${OBJECT_JOB_SCHEMA_VERSION} only`,
      );
    if (job.kind !== job.request.kind)
      throw new Error(
        `Job "${jobId}" is contradictory: record kind ${JSON.stringify(job.kind)} does not match request kind ${JSON.stringify(job.request?.kind)} — it cannot be trusted and will not run`,
      );
    if (job.schemaVersion === PLATE_JOB_SCHEMA_VERSION && job.kind !== "plate")
      throw new Error(
        `Job "${jobId}" claims schemaVersion ${PLATE_JOB_SCHEMA_VERSION}, which is plate-only, but its kind is ${JSON.stringify(job.kind)} — object jobs require schemaVersion ${OBJECT_JOB_SCHEMA_VERSION}`,
      );
    return job;
  } catch (err) {
    throw new Error(`Job "${jobId}" has an unreadable record: ${(err as Error).message}`);
  }
}

export async function listJobs(jobRoot: string): Promise<JobSummary[]> {
  let entries: string[];
  try {
    entries = (await stat(jobRoot)).isDirectory() ? await readdir(jobRoot) : [];
  } catch {
    return [];
  }
  const jobs: JobSummary[] = [];
  for (const entry of entries.sort()) {
    try {
      const job = await loadJob(jobRoot, entry);
      jobs.push({
        jobId: job.jobId,
        kind: job.kind,
        subject: job.request.subject,
        createdAt: job.createdAt,
        runs: job.runs.length,
        candidates: job.runs.reduce((n, r) => n + r.candidates.length, 0),
      });
    } catch {
      // Unreadable directories are not jobs (temp files, partial writes) — skip.
    }
  }
  return jobs;
}

/**
 * Adopt a recorded candidate as a new immutable Asset — the kind follows the
 * job: a plate job adopts a Plate Asset, an object job verifies the
 * candidate's true alpha (REQ-015) and adopts an Object Asset. The candidate
 * is addressed by exact content hash (a unique prefix is accepted); its bytes
 * are re-derived and verified before adoption, so a tampered or missing file
 * cannot enter the library under a stale identity. Overwriting an existing
 * asset is unrepresentable — the write path refuses existing ids.
 */
export async function adoptCandidate(
  jobRoot: string,
  jobId: string,
  candidateRef: string,
  assetId: string,
  opts: { libraryRoot: string; name?: string; tags?: string[] },
): Promise<{ assetId: string; contentHash: string; imagePath: string; adoptedFrom: string }> {
  const job = await loadJob(jobRoot, jobId);
  // Uniqueness is on content identity: the same bytes recurring across runs
  // collapse to one candidate, so ambiguity only means two distinct hashes.
  const byHash = new Map<string, { cand: JobCandidate; run: JobRun }>();
  for (const { cand, run } of job.runs.flatMap((run) =>
    run.candidates.map((cand) => ({ cand, run })),
  )) {
    if (cand.contentHash.startsWith(candidateRef) && !byHash.has(cand.contentHash))
      byHash.set(cand.contentHash, { cand, run });
  }
  if (byHash.size === 0)
    throw new Error(`Job "${jobId}" has no candidate matching "${candidateRef}"`);
  if (byHash.size > 1)
    throw new Error(
      `Candidate reference "${candidateRef}" is ambiguous — it matches ${byHash.size} distinct candidates; use a longer hash prefix`,
    );
  // A recurring hash resolves to its first recorded run — the earliest lineage.
  const { cand, run } = byHash.values().next().value!;

  const bytes = await readFile(path.join(jobDir(jobRoot, jobId), cand.file));
  const actual = sha256(bytes);
  if (actual !== cand.contentHash)
    throw new Error(
      `Candidate file "${cand.file}" no longer matches its recorded identity (sha-256 ${cand.contentHash}, actual ${actual}) — it cannot be adopted`,
    );

  const adoptedFrom = `job:${jobId}#${cand.contentHash}`;
  const provenance = {
    ...(job.request.subject ? { subject: job.request.subject } : {}),
    ...(run.fullPrompt ? { fullPrompt: run.fullPrompt } : {}),
    model: run.model,
    adoptedFrom,
  };

  if (job.kind === "object") {
    // The alpha gate runs before any write: an opaque candidate is exactly
    // the chroma-key shape REQ-015 forbids, and it must not enter the library.
    verifyTrueAlpha(bytes, cand.file);
    // The gate just proved the bytes are PNG — the recorded mediaType is
    // derived, not authoritative, and object assets are contractually
    // object.png (writeObjectAsset hardcodes the type, so a mislabeled
    // candidate cannot produce object.jpg).
    const imagePath = await writeObjectAsset(opts.libraryRoot, assetId, bytes, {
      kind: "object",
      id: assetId,
      name: opts.name ?? assetId,
      tags: opts.tags ?? [],
      ...provenance,
      matting: "true-alpha",
    });
    return { assetId, contentHash: cand.contentHash, imagePath, adoptedFrom };
  }

  const imagePath = await writePlateAsset(opts.libraryRoot, assetId, bytes, {
    kind: "plate",
    id: assetId,
    name: opts.name ?? assetId,
    tags: opts.tags ?? [],
    ...provenance,
  }, cand.mediaType);
  return { assetId, contentHash: cand.contentHash, imagePath, adoptedFrom };
}
