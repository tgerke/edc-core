import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import * as oidc from "openid-client";
import type { Db } from "../db/client.js";
import { auditEvents, users } from "../db/schema/index.js";
import type { OidcConfig } from "./config.js";

/**
 * Single-IdP OIDC client (authorization-code + PKCE). Discovery is attempted
 * at boot and retried lazily, so a temporarily unreachable IdP delays SSO
 * logins instead of preventing API startup.
 */
export class OidcClient {
  private discovered: oidc.Configuration | null = null;
  private discovering: Promise<oidc.Configuration> | null = null;

  constructor(private readonly config: OidcConfig) {}

  private async discover(): Promise<oidc.Configuration> {
    if (this.discovered) return this.discovered;
    this.discovering ??= (async () => {
      const issuer = new URL(this.config.issuerUrl);
      const discovered = await oidc.discovery(
        issuer,
        this.config.clientId,
        this.config.clientSecret,
        undefined,
        // http issuers are for local development and tests only.
        issuer.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : undefined,
      );
      this.discovered = discovered;
      return discovered;
    })();
    try {
      return await this.discovering;
    } finally {
      this.discovering = null;
    }
  }

  /** Boot-time discovery attempt; failures are retried on first login. */
  async warmUp(): Promise<void> {
    await this.discover();
  }

  async buildAuthorizationUrl(
    flow: { state: string; nonce: string; codeChallenge: string },
    purpose: "login" | "reauth",
  ): Promise<URL> {
    const discovered = await this.discover();
    return oidc.buildAuthorizationUrl(discovered, {
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: flow.codeChallenge,
      code_challenge_method: "S256",
      // Re-auth must be a fresh interactive login: prompt=login forces
      // credential re-entry, max_age=0 obliges the IdP to include auth_time.
      ...(purpose === "reauth" ? { prompt: "login", max_age: "0" } : {}),
    });
  }

  /** Exchanges the callback code and returns the validated ID-token claims. */
  async exchangeCode(
    callbackUrl: URL,
    flow: { state: string; nonce: string; codeVerifier: string },
  ): Promise<oidc.IDToken> {
    const discovered = await this.discover();
    const tokens = await oidc.authorizationCodeGrant(discovered, callbackUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("token response carried no ID token");
    return claims;
  }
}

export interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  purpose: "login" | "reauth";
  returnTo: string;
  iat: number;
}

// HMAC key for the short-lived flow-state cookie. Per-process on purpose: a
// restart mid-login just means the user clicks "Continue with SSO" again.
const stateCookieKey = randomBytes(32);
const FLOW_STATE_MAX_AGE_SECONDS = 600;

export async function newFlowState(
  purpose: "login" | "reauth",
  returnTo: string,
): Promise<{ flow: OidcFlowState; codeChallenge: string }> {
  const codeVerifier = oidc.randomPKCECodeVerifier();
  return {
    flow: {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      codeVerifier,
      purpose,
      returnTo,
      iat: Math.floor(Date.now() / 1000),
    },
    codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
  };
}

export function encodeFlowState(flow: OidcFlowState): string {
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");
  const mac = createHmac("sha256", stateCookieKey).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function decodeFlowState(cookie: string): OidcFlowState | null {
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = cookie.slice(0, dot);
  const mac = createHmac("sha256", stateCookieKey).update(payload).digest("base64url");
  if (mac !== cookie.slice(dot + 1)) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, "base64url").toString()) as OidcFlowState;
    if (Math.floor(Date.now() / 1000) - flow.iat > FLOW_STATE_MAX_AGE_SECONDS) return null;
    return flow;
  } catch {
    return null;
  }
}

/** Guards the post-login redirect against open-redirect targets. */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return "/studies";
  return raw;
}

export class OidcProvisionError extends Error {
  constructor(public readonly code: "missing_email" | "deactivated") {
    super(code);
  }
}

/** Drizzle wraps the postgres.js error; walk the cause chain for 23505. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const pg = e as { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === constraint) return true;
    if (e.message.includes(constraint)) return true;
  }
  return false;
}

function usernameCandidates(claims: oidc.IDToken): string[] {
  const preferred = typeof claims.preferred_username === "string" ? claims.preferred_username : "";
  const email = typeof claims.email === "string" ? claims.email : "";
  const base = (preferred || email.split("@")[0] || `user-${String(claims.sub).slice(0, 8)}`)
    .toLowerCase()
    .replace(/[^a-z0-9._@-]/g, "-");
  return [base, ...Array.from({ length: 20 }, (_, i) => `${base}${i + 2}`)];
}

/**
 * Just-in-time provisioning: subject match first, then verified-email link,
 * then account creation. New accounts get no study roles and never system
 * administration — capabilities always come from explicit grants (P11-04).
 */
export async function provisionOidcUser(db: Db, claims: oidc.IDToken): Promise<{ userId: string }> {
  const sub = String(claims.sub);
  const [bySubject] = await db.select().from(users).where(eq(users.oidcSubject, sub)).limit(1);
  if (bySubject) {
    if (bySubject.status !== "active") throw new OidcProvisionError("deactivated");
    return { userId: bySubject.id };
  }

  const email = typeof claims.email === "string" ? claims.email : null;
  if (!email) throw new OidcProvisionError("missing_email");

  if (claims.email_verified !== false) {
    const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (byEmail) {
      if (byEmail.status !== "active") throw new OidcProvisionError("deactivated");
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ oidcSubject: sub, updatedAt: new Date() })
          .where(eq(users.id, byEmail.id));
        await tx.insert(auditEvents).values({
          actorId: byEmail.id,
          action: "user.oidc_linked",
          entityType: "user",
          entityId: byEmail.id,
          newValue: { oidcSubject: sub },
        });
      });
      return { userId: byEmail.id };
    }
  }

  const fullName =
    (typeof claims.name === "string" && claims.name) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    email;

  for (const username of usernameCandidates(claims)) {
    try {
      return await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({ username, email, fullName, passwordHash: null, oidcSubject: sub })
          .returning();
        if (!created) throw new Error("user insert returned no row");
        await tx.insert(auditEvents).values({
          actorId: created.id,
          action: "user.provisioned",
          entityType: "user",
          entityId: created.id,
          newValue: { username, email, oidcSubject: sub },
        });
        return { userId: created.id };
      });
    } catch (err) {
      // Retry only on username collisions; email collisions can't occur here
      // (an existing email row was linked above).
      if (isUniqueViolation(err, "users_username_unique")) continue;
      throw err;
    }
  }
  throw new Error("could not allocate a unique username after 21 attempts");
}
