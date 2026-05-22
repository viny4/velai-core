import jwt from "jsonwebtoken";
import { config } from "../config";

/** The session token. Carries the user's home district for the default feed. */
export interface AuthPayload {
  sub: string; // profile id
  district: string; // district slug, e.g. "madurai"
  name: string;
  role: string;
  phone: string;
}

export function signToken(p: AuthPayload): string {
  return jwt.sign(p, config.jwtSecret, { expiresIn: "30d" });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, config.jwtSecret) as AuthPayload;
}

/**
 * Short-lived token issued after Google verifies a NEW user, carrying the
 * verified Google identity into the onboarding step (where they pick a
 * district). Avoids verifying the Google token twice.
 */
export interface OnboardingPayload {
  kind: "google_onboarding";
  google_sub: string;
  email: string;
  name: string;
  picture: string | null;
}

export function signOnboardingToken(p: OnboardingPayload): string {
  return jwt.sign(p, config.jwtSecret, { expiresIn: "20m" });
}

export function verifyOnboardingToken(token: string): OnboardingPayload {
  const decoded = jwt.verify(token, config.jwtSecret) as OnboardingPayload;
  if (decoded.kind !== "google_onboarding")
    throw new Error("Not an onboarding token");
  return decoded;
}
