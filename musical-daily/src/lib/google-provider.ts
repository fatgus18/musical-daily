import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import type { AccountConfig } from "./account-config.ts";
import type { Identity } from "./account-store.ts";
export interface GoogleProvider {
  authorization(input: { state: string; nonce: string; challenge: string }): string;
  identity(code: string, verifier: string, nonce: string): Promise<Identity>;
}
export function googleProvider(config: AccountConfig): GoogleProvider {
  const callback = `${config.hub}/api/auth/google/callback`;
  const client = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: callback, transporterOptions: { timeout: 10000, retry: false } });
  return {
    authorization({ state, nonce, challenge }) {
      return client.generateAuthUrl({ scope: ["openid", "email", "profile"], state, nonce, code_challenge: challenge, code_challenge_method: CodeChallengeMethod.S256, access_type: "online" });
    },
    async identity(code, verifier, nonce) {
      const { tokens } = await client.getToken({ code, codeVerifier: verifier, redirect_uri: callback });
      if (!tokens.id_token) throw new Error("Google returned no identity");
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
      return verifiedGoogleIdentity(ticket.getPayload() as unknown as Record<string, unknown>, config.clientId, nonce);
    },
  };
}

// Called only after the Google library verifies the JWT signature and expiry.
export function verifiedGoogleIdentity(payload: Record<string, unknown> | undefined, clientId: string, nonce: string): Identity {
  if (!payload || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255 || typeof payload.email !== "string" || !payload.email || payload.email.length > 320 || payload.email_verified !== true || payload.nonce !== nonce || payload.aud !== clientId || !["accounts.google.com", "https://accounts.google.com"].includes(String(payload.iss))) throw new Error("Google identity verification failed");
  return { sub: payload.sub, email: payload.email, name: (typeof payload.name === "string" && payload.name ? payload.name : payload.email.split("@")[0]).slice(0, 120), picture: typeof payload.picture === "string" && payload.picture.startsWith("https://") ? payload.picture : null };
}
