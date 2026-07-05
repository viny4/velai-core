import { OAuth2Client } from "google-auth-library";
import { config } from "../config";
import { ApiError } from "./errors";

const client = new OAuth2Client(config.googleClientId);

export interface GoogleUser {
  sub: string; // stable Google user id
  email: string;
  name: string;
  picture: string | null;
}

/**
 * Verify a Google ID token (the credential from the "Sign in with Google"
 * button) and return the user's identity. Throws if the token is invalid or
 * not issued for this app's client id.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleUser> {
  if (!config.googleClientId)
    throw new ApiError(503, "Google login is not configured on the server");

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: config.googleClientId,
    });
  } catch (err) {
    console.error("Google Auth Error:", err);
    throw new ApiError(401, "Google sign-in could not be verified");
  }

  const p = ticket.getPayload();
  if (!p?.sub || !p.email)
    throw new ApiError(401, "Google account has no usable email");

  return {
    sub: p.sub,
    email: p.email,
    name: p.name ?? p.email,
    picture: p.picture ?? null,
  };
}
