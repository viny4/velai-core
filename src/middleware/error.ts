import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../lib/errors";

/** Last middleware: turns any thrown error into a clean JSON response. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Postgres unique-violation -> friendly 409
  if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
    res.status(409).json({ error: "This record already exists" });
    return;
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
}
