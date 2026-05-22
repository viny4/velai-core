import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";

/**
 * Requires a valid Bearer token. On success attaches req.auth, which carries
 * the user's id, role, and — crucially — their tenant schema.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Please login to continue" });
    return;
  }
  try {
    req.auth = verifyToken(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: "Session expired, please login again" });
  }
}
