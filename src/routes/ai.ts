import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { extractJob, geminiAvailable } from "../lib/gemini";

const router = Router();
router.use(requireAuth);

/**
 * POST /api/ai/parse-job — voice job posting.
 * Takes a spoken transcript and uses the LLM to extract a structured job
 * draft (named-entity extraction). The client pre-fills the post form with it.
 */
router.post("/parse-job", async (req, res) => {
  if (!geminiAvailable())
    throw new ApiError(503, "Voice posting is not available right now");

  const transcript = req.body?.transcript;
  if (typeof transcript !== "string" || transcript.trim().length < 3)
    throw new ApiError(400, "Please speak the job details clearly");

  const draft = await extractJob(transcript.trim());
  if (!draft)
    throw new ApiError(502, "Could not understand that — please try again");

  res.json({ draft });
});

export default router;
