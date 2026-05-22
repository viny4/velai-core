/**
 * Job embeddings — turns a job into a 768-dimension vector for semantic
 * search and embedding-based recommendations (stored in the pgvector column).
 */
import { pool } from "../db/pool";
import { embedText } from "./gemini";

interface JobLike {
  title: string;
  description?: string | null;
  job_type: string;
  village?: string | null;
}

/** The text representation of a job that gets embedded. */
export function jobEmbeddingText(job: JobLike): string {
  return [job.title, job.description ?? "", job.job_type, job.village ?? ""]
    .filter(Boolean)
    .join(". ");
}

/** Format a number[] as a pgvector literal: [0.1,0.2,...] */
export function toVectorLiteral(vec: number[]): string {
  return "[" + vec.join(",") + "]";
}

/**
 * Embed a job and store its vector. Fire-and-forget safe: if the AI is
 * unavailable it simply does nothing (the job keeps a NULL embedding).
 */
export async function embedAndStoreJob(
  jobId: string,
  job: JobLike,
): Promise<void> {
  try {
    const vec = await embedText(jobEmbeddingText(job));
    if (!vec) return;
    await pool.query(`update jobs set embedding = $1 where id = $2`, [
      toVectorLiteral(vec),
      jobId,
    ]);
  } catch (e) {
    console.error("embedAndStoreJob failed:", e);
  }
}
