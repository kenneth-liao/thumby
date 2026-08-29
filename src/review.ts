/**
 * Creator candidate review (REQ-017): an offline evidence package for judging
 * likeness. One command writes `<jobDir>/review.html` — a contact sheet of
 * every distinct candidate across all runs, plus a face-detail section that
 * applies the *same* deterministic center-crop geometry to every candidate
 * and every identity anchor, so crops are directly comparable. There is no
 * face detection here: the crop is a fixed relative region, labeled as such,
 * and the sheet is evidence for the human likeness gate (DEC-004), never an
 * automated verdict.
 *
 * Nothing in the sheet feeds back into Scenes or the library — it is derived
 * output, regenerable at any time from the job record.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadJob } from "./jobs.js";

export interface ReviewCandidate {
  contentHash: string;
  /** Path relative to the job directory. */
  file: string;
  /** The run that produced this candidate (first occurrence of the hash). */
  runIndex: number;
  /** ISO timestamp of that run. */
  ranAt: string;
}

export interface ReviewAnchor {
  id: string;
  path: string;
}

export interface CreatorReview {
  jobId: string;
  reviewPath: string;
  candidates: ReviewCandidate[];
  anchors: ReviewAnchor[];
}

/**
 * The face-detail crop geometry, in percent of the source image: a centered
 * square from the upper-middle band, where portrait faces land. Identical for
 * every image on the sheet — that is what makes the views comparable.
 */
const FACE_CROP = { width: 200, left: -50, top: -32 } as const;

export async function reviewCreatorJob(
  jobRoot: string,
  jobId: string,
): Promise<CreatorReview> {
  const job = await loadJob(jobRoot, jobId);
  if (job.kind !== "creator")
    throw new Error(
      `Job "${jobId}" is a ${job.kind} job — review sheets compare candidates against identity anchors, which only creator jobs carry`,
    );

  // Anchors come from the recorded request; a missing anchor file fails
  // loudly — a review against fewer anchors than were generated with is
  // false evidence.
  const anchors: ReviewAnchor[] = [];
  for (const ref of job.request.refs.filter((r) => r.role === "identity")) {
    try {
      await readFile(path.resolve(ref.path));
    } catch {
      throw new Error(
        `Identity anchor "${ref.path}" is missing — the review needs every identity anchor the job was generated with`,
      );
    }
    anchors.push({ id: path.basename(ref.path, path.extname(ref.path)), path: ref.path });
  }

  // Distinct candidates across all runs, in run order; a recurring hash
  // resolves to its first recorded run (same rule as adoption).
  const seen = new Map<string, ReviewCandidate>();
  job.runs.forEach((run, runIndex) => {
    for (const cand of run.candidates) {
      if (!seen.has(cand.contentHash))
        seen.set(cand.contentHash, {
          contentHash: cand.contentHash,
          file: cand.file,
          runIndex,
          ranAt: run.ranAt,
        });
    }
  });
  const candidates = [...seen.values()];

  const html = renderReviewSheet(job.jobId, path.join(jobRoot, jobId), job.request.subject, candidates, anchors);
  const reviewPath = path.join(jobRoot, jobId, "review.html");
  await writeFile(reviewPath, html);
  return { jobId: job.jobId, reviewPath, candidates, anchors };
}

function jobDir(jobRoot: string, jobId: string): string {
  return path.join(jobRoot, jobId);
}

function fileUrl(p: string): string {
  return `file://${path.resolve(p)}`;
}

function renderReviewSheet(
  jobId: string,
  jobDirectory: string,
  subject: string,
  candidates: ReviewCandidate[],
  anchors: ReviewAnchor[],
): string {
  const figure = (src: string, caption: string) =>
    `<figure><div class="frame"><img src="${fileUrl(src)}"></div><figcaption>${caption}</figcaption></figure>`;
  const face = (src: string, caption: string) =>
    `<figure><div class="face"><img src="${fileUrl(src)}" style="width:${FACE_CROP.width}%;left:${FACE_CROP.left}%;top:${FACE_CROP.top}%"></div><figcaption>${caption}</figcaption></figure>`;

  // Every image src is an absolute file:// URL: candidates live inside the
  // job directory, anchors live wherever the request recorded them (typically
  // the identity kit) — the same approach as the library contact sheet.
  const jobPath = (file: string) => path.join(jobDirectory, file);
  const candidateFull = candidates
    .map((c) =>
      figure(
        jobPath(c.file),
        `run ${c.runIndex} · <code>${c.contentHash.slice(0, 12)}</code> · ${c.ranAt}`,
      ),
    )
    .join("\n");
  const anchorFaces = anchors
    .map((a) => face(a.path, `anchor · ${a.id}`))
    .join("\n");
  const candidateFaces = candidates
    .map((c) => face(jobPath(c.file), `run ${c.runIndex} · <code>${c.contentHash.slice(0, 12)}</code>`))
    .join("\n");

  return `<!doctype html><meta charset="utf-8"><title>creator review — ${jobId}</title>
<style>
body{background:#0b0b0d;color:#e7e7ea;font:14px/1.5 -apple-system,sans-serif;margin:0;padding:32px}
h1,h2{font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a8a94;margin:24px 0}
h1{font-size:15px}h2{font-size:12px}
.meta{color:#8a8a94;font-size:12px;margin:0 0 8px}
.g{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
figure{margin:0;background:linear-gradient(160deg,#16181d,#0e1013);border:1px solid #26282e;border-radius:8px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:12px}
.frame{width:100%;height:180px;border-radius:4px;
  background:repeating-conic-gradient(#1c1e24 0% 25%, #121419 0% 50%) 50%/24px 24px}
.frame img{width:100%;height:100%;object-fit:contain;display:block}
.face{position:relative;width:160px;aspect-ratio:1;overflow:hidden;border-radius:4px;
  background:repeating-conic-gradient(#1c1e24 0% 25%, #121419 0% 50%) 50%/24px 24px}
.face img{position:absolute;max-width:none;display:block}
figcaption{font-size:11px;color:#8a8a94;font-family:ui-monospace,monospace;text-align:center}
</style>
<h1>Creator review · ${jobId}</h1>
<p class="meta">subject: ${subject} · ${candidates.length} candidate(s) · face detail uses the same fixed crop on every image — it is not face detection; likeness judgment is human (DEC-004)</p>
<h2>candidates — full view (checkerboard shows the alpha matte)</h2>
<div class="g">${candidateFull || "<p>no candidates</p>"}</div>
<h2>face detail — identity anchors first, same crop for every image</h2>
<div class="g">${anchorFaces}${candidateFaces}</div>
</body>`;
}
