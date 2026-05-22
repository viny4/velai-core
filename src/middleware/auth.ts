import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";

/** Requires a valid Bearer token; rejects the request with 401 otherwise. */
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

/**
 * Attaches req.auth IF a valid token is present, but never rejects.
 * Used for routes anyone can view (job browsing) where a logged-in user
 * gets a personalised response and a guest gets a public one.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      req.auth = verifyToken(header.slice(7));
    } catch {
      /* invalid token — treat as a guest */
    }
  }
  next();
}
