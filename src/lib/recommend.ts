/**
 * Content-based job recommendation — the data-mining core of the project.
 *
 * How it works:
 *  1. PREFERENCE VECTOR — build a vector from the job types the worker has
 *     shown interest in (their job_responses history). Each job type is a
 *     dimension; the value is how often the worker engaged with that type.
 *  2. JOB VECTOR — each job is a one-hot vector over its own job_type.
 *  3. COSINE SIMILARITY — measure how well a job matches the worker's
 *     preference vector.
 *  4. HYBRID SCORE — blend the content similarity with proximity (distance)
 *     and recency, so the result is both relevant and practical.
 *  5. COLD START — a worker with no history has a zero preference vector;
 *     they are ranked on proximity + recency alone.
 *
 *      score = 0.55·similarity  +  0.30·proximity  +  0.15·recency
 */

export interface ScorableJob {
  job_type: string;
  distance_km: number | null;
  created_at: string | Date;
}

// Weights of the hybrid score (sum = 1).
const W_SIMILARITY = 0.55; // content match — the worker's preferred work
const W_PROXIMITY = 0.3; // how near the job is
const W_RECENCY = 0.15; // how fresh the job is

/** Step 1 — preference vector: frequency of each job type in the history. */
export function buildPreferenceVector(
  historyTypes: string[],
): Map<string, number> {
  const vector = new Map<string, number>();
  for (const type of historyTypes) {
    vector.set(type, (vector.get(type) ?? 0) + 1);
  }
  return vector;
}

/** Euclidean norm ‖v‖ of a sparse vector. */
function vectorNorm(vector: Map<string, number>): number {
  let sumOfSquares = 0;
  for (const value of vector.values()) sumOfSquares += value * value;
  return Math.sqrt(sumOfSquares);
}

/**
 * Step 3 — cosine similarity between the worker profile and a job.
 * The job is a one-hot vector (1 in its own job_type, 0 elsewhere), so:
 *   dot(profile, job) = profile[job_type]
 *   ‖job‖             = 1
 *   cosine            = profile[job_type] / ‖profile‖
 */
function cosineSimilarity(
  profile: Map<string, number>,
  profileNorm: number,
  jobType: string,
): number {
  if (profileNorm === 0) return 0; // cold start — no history yet
  return (profile.get(jobType) ?? 0) / profileNorm;
}

/** Nearer jobs score higher: 1.0 at 0 km, 0.5 at 8 km, → 0 far away. */
function proximityScore(distanceKm: number | null): number {
  if (distanceKm == null) return 0.4; // unknown location — neutral
  return 1 / (1 + distanceKm / 8);
}

/** Fresher jobs score higher: 1.0 today → 0 after 14 days. */
function recencyScore(createdAt: string | Date): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  return Math.max(0, 1 - ageDays / 14);
}

export interface Scored<T> {
  job: T;
  score: number; // 0..1
}

/**
 * Rank a list of candidate jobs for one worker, best match first.
 * `historyTypes` is the list of job types the worker has shown interest in.
 */
export function recommendJobs<T extends ScorableJob>(
  jobs: T[],
  historyTypes: string[],
): Scored<T>[] {
  const profile = buildPreferenceVector(historyTypes);
  const profileNorm = vectorNorm(profile);

  return jobs
    .map((job) => {
      const similarity = cosineSimilarity(
        profile,
        profileNorm,
        job.job_type,
      );
      const proximity = proximityScore(job.distance_km);
      const recency = recencyScore(job.created_at);
      const score =
        W_SIMILARITY * similarity +
        W_PROXIMITY * proximity +
        W_RECENCY * recency;
      return { job, score };
    })
    .sort((a, b) => b.score - a.score);
}
