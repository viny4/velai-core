import type { AuthPayload } from "./lib/jwt";

// Adds the authenticated user (with their tenant) to Express requests.
declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export {};
