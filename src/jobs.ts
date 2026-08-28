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
import { extensionFor, writePlateAsset } from "./assets.js";

export const JOB_SCHEMA_VERSION = 1 as const;

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
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  jobId: string;
  kind: "plate";
  createdAt: string;
  request: PlateJobRequest;
  runs: JobRun[];
}

export interface JobSummary {
  jobId: string;
  kind: "plate";
  subject: string;
  createdAt: string;
  runs: number;
  candidates: number;
}

/** The injectable generation seam — the AI SDK boundary lives behind this. */
export interface GeneratedBatch {
  plates: { bytes: Uint8Array; mediaType: string }[];
  warnings: string[];
  fullPrompt: string;
}
export type PlateGenerator = (request: PlateJobRequest) => Promise<GeneratedBatch>;

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
 * Execute a plate request as a new Generation Job and record the run.
 * Creating over an existing job id is refused — `rerunPlateJob` is the only
 * way to add candidates, so a lineage can never be silently mixed.
 */
export async function runPlateJob(
  jobRoot: string,
  jobId: string,
  request: PlateJobRequest,
  generate: PlateGenerator,
): Promise<GenerationJob> {
  if (!JOB_ID_PATTERN.test(jobId))
    throw new Error(`Invalid job id "${jobId}" — use lowercase letters/digits/hyphens`);
  if (existsSync(path.join(jobRoot, jobId, "job.json")))
    throw new Error(`Job "${jobId}" already exists — use "jobs rerun ${jobId}" to add candidates under its lineage`);

  const batch = await generate(request);
  const now = new Date().toISOString();
  const job: GenerationJob = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    kind: "plate",
    createdAt: now,
    request,
    runs: [],
  };
  const run = await recordRun(jobRoot, job, request, batch, now);
  job.runs.push(run);
  await writeJobRecord(jobRoot, job);
  return job;
}

/**
 * Re-execute a job's recorded request and append the run to its lineage.
 * Reference identities are re-derived and compared first — drifted or
 * missing references fail loudly, because a rerun with different reference
 * content would be a different job wearing the same id.
 */
export async function rerunPlateJob(
  jobRoot: string,
  jobId: string,
  generate: PlateGenerator,
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

/** Call the generator, persist the candidates, and build the run record. */
async function recordRun(
  jobRoot: string,
  job: GenerationJob,
  request: PlateJobRequest,
  batch: GeneratedBatch,
  ranAt: string,
): Promise<JobRun> {
  if (batch.plates.length === 0) throw new Error("Generation returned no candidates");
  const spec = resolveModel(request.model);
  const dir = jobDir(jobRoot, job.jobId);
  const candidatesDir = path.join(dir, "candidates");
  await mkdir(candidatesDir, { recursive: true });

  const candidates: JobCandidate[] = [];
  for (const plate of batch.plates) {
    const contentHash = sha256(plate.bytes);
    const file = path.join("candidates", `${contentHash}.${extensionFor(plate.mediaType)}`);
    await writeFile(path.join(dir, file), plate.bytes);
    candidates.push({ contentHash, file, mediaType: plate.mediaType });
  }

  return {
    ranAt,
    model: spec.id,
    fullPrompt: batch.fullPrompt,
    costUsd: spec.approxCost * batch.plates.length,
    costMeasured: spec.costMeasured,
    warnings: batch.warnings,
    candidates,
  };
}

/** Load a job record; missing or corrupt records fail loudly. */
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
    if (job.schemaVersion !== JOB_SCHEMA_VERSION)
      throw new Error(`unsupported job schemaVersion ${job.schemaVersion}`);
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
 * Adopt a recorded candidate as a new immutable Plate Asset. The candidate is
 * addressed by exact content hash (a unique prefix is accepted); its bytes are
 * re-derived and verified before adoption, so a tampered or missing file
 * cannot enter the library under a stale identity. Overwriting an existing
 * asset is unrepresentable — `writePlateAsset` refuses existing ids.
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
  const imagePath = await writePlateAsset(opts.libraryRoot, assetId, bytes, {
    kind: "plate",
    id: assetId,
    name: opts.name ?? assetId,
    tags: opts.tags ?? [],
    ...(job.request.subject ? { subject: job.request.subject } : {}),
    ...(run.fullPrompt ? { fullPrompt: run.fullPrompt } : {}),
    model: run.model,
    adoptedFrom,
  }, cand.mediaType);
  return { assetId, contentHash: cand.contentHash, imagePath, adoptedFrom };
}
