import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { importStudyBuild } from "../services/study-builds.js";
import type { AuthConfig } from "./config.js";
import { hashPassword } from "./password.js";
import { grantRole } from "./rbac.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping OIDC tests: no database at ${databaseUrl()}.`);
}

/**
 * Minimal in-process OIDC issuer: serves discovery + JWKS and a token
 * endpoint that signs whatever `nextClaims` holds. The authorize endpoint is
 * never fetched server-side (the API only redirects browsers to it), so it
 * isn't implemented.
 */
async function startMockIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const app = Fastify();
  // openid-client POSTs the token request as application/x-www-form-urlencoded.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  const state = {
    issuer: "",
    nextClaims: {} as Record<string, unknown>,
    nextNonce: "",
  };

  app.get("/.well-known/openid-configuration", async () => ({
    issuer: state.issuer,
    authorization_endpoint: `${state.issuer}/authorize`,
    token_endpoint: `${state.issuer}/token`,
    jwks_uri: `${state.issuer}/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  }));
  app.get("/jwks", async () => ({ keys: [jwk] }));
  app.post("/token", async () => {
    const idToken = await new SignJWT({ nonce: state.nextNonce, ...state.nextClaims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(state.issuer)
      .setAudience("edc-client")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return { access_token: "at-test", token_type: "bearer", id_token: idToken, expires_in: 300 };
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no issuer port");
  state.issuer = `http://127.0.0.1:${address.port}`;
  return { app, state };
}

function decodeStateCookie(cookieValue: string): { state: string; nonce: string } {
  const payload = cookieValue.slice(0, cookieValue.lastIndexOf("."));
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

const ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="OIDC" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-10T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.OIDC" StudyName="OIDC Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Vitals" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.HR" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.HR" Name="Heart rate" DataType="integer"/>
    </MetaDataVersion>
  </Study>
</ODM>`;

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("OIDC SSO (integration, mock issuer)", () => {
  let issuer: Awaited<ReturnType<typeof startMockIssuer>>;
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);

  function authConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
    return {
      passwordMinLength: 12,
      maxFailedLogins: 5,
      lockoutMinutes: 15,
      sessionIdleMinutes: 30,
      sessionAbsoluteHours: 8,
      oidc: {
        issuerUrl: issuer.state.issuer,
        clientId: "edc-client",
        clientSecret: "edc-secret",
        redirectUri: "http://127.0.0.1:5173/api/auth/oidc/callback",
        scopes: "openid profile email",
        providerLabel: "MSK SSO",
        reauthMaxAgeSeconds: 120,
      },
      oidcOnly: false,
      ...overrides,
    };
  }

  /** Runs the browser side of the code flow against our own endpoints. */
  async function ssoRoundTrip(
    claims: Record<string, unknown>,
    opts: { purpose?: "login" | "reauth"; tamperState?: boolean } = {},
  ) {
    const start = await server.inject({
      method: "GET",
      url: `/auth/oidc/login${opts.purpose === "reauth" ? "?purpose=reauth" : ""}`,
    });
    expect(start.statusCode).toBe(302);
    const authorizeUrl = new URL(start.headers.location as string);
    expect(authorizeUrl.origin).toBe(issuer.state.issuer);
    const stateCookie = start.cookies.find((c) => c.name === "edc_oidc_state");
    if (!stateCookie) throw new Error("no state cookie set");
    const flow = decodeStateCookie(stateCookie.value);
    expect(authorizeUrl.searchParams.get("state")).toBe(flow.state);
    if (opts.purpose === "reauth") {
      expect(authorizeUrl.searchParams.get("prompt")).toBe("login");
    }

    issuer.state.nextNonce = flow.nonce;
    issuer.state.nextClaims = claims;
    const callbackState = opts.tamperState ? `${flow.state}-tampered` : flow.state;
    return server.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=test-code&state=${callbackState}`,
      cookies: { edc_oidc_state: stateCookie.value },
    });
  }

  function sessionCookie(res: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
    const cookie = res.cookies.find((c) => c.name === "edc_session");
    if (!cookie) throw new Error("no session cookie");
    return cookie.value;
  }

  beforeAll(async () => {
    await runMigrations();
    issuer = await startMockIssuer();
    server = await buildServer({ db, authConfig: authConfig() });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await issuer.app.close();
    await client.end();
  });

  it("advertises SSO in /auth/config", async () => {
    const res = await server.inject({ method: "GET", url: "/auth/config" });
    expect(res.json()).toEqual({
      oidcEnabled: true,
      oidcOnly: false,
      providerLabel: "MSK SSO",
      passwordLoginEnabled: true,
    });
  });

  it("provisions a new user just-in-time and starts a session", async () => {
    const res = await ssoRoundTrip({
      sub: `sub-jit-${suffix}`,
      email: `jit-${suffix}@example.com`,
      email_verified: true,
      name: "Jane Investigator",
      preferred_username: `jane-${suffix}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/studies");

    const me = await server.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { edc_session: sessionCookie(res) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      username: `jane-${suffix}`,
      fullName: "Jane Investigator",
      isSystemAdmin: false,
      hasPassword: false,
    });

    const [created] = await db
      .select()
      .from(users)
      .where(eq(users.oidcSubject, `sub-jit-${suffix}`));
    expect(created?.passwordHash).toBeNull();
    const trail = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "user.provisioned"),
          eq(auditEvents.entityId, created?.id ?? ""),
        ),
      );
    expect(trail).toHaveLength(1);
  });

  it("links an existing account by verified email instead of duplicating it", async () => {
    const [existing] = await db
      .insert(users)
      .values({
        username: `local-${suffix}`,
        email: `link-${suffix}@example.com`,
        fullName: "Local User",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    if (!existing) throw new Error("fixture failed");

    const res = await ssoRoundTrip({
      sub: `sub-link-${suffix}`,
      email: `link-${suffix}@example.com`,
      email_verified: true,
      name: "Local User",
    });
    expect(res.statusCode).toBe(302);
    const me = await server.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { edc_session: sessionCookie(res) },
    });
    // Same account: username unchanged, and the local password still counts.
    expect(me.json()).toMatchObject({ username: `local-${suffix}`, hasPassword: true });
    const [linked] = await db.select().from(users).where(eq(users.id, existing.id));
    expect(linked?.oidcSubject).toBe(`sub-link-${suffix}`);
  });

  it("suffixes the username when the preferred one is taken", async () => {
    await db.insert(users).values({
      username: `taken-${suffix}`,
      email: `taken-${suffix}@example.com`,
      fullName: "First Owner",
      passwordHash: await hashPassword(PASSWORD),
    });
    const res = await ssoRoundTrip({
      sub: `sub-collide-${suffix}`,
      email: `collide-${suffix}@example.com`,
      email_verified: true,
      preferred_username: `taken-${suffix}`,
    });
    expect(res.statusCode).toBe(302);
    const me = await server.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { edc_session: sessionCookie(res) },
    });
    expect(me.json().username).toBe(`taken-${suffix}2`);
  });

  it("rejects a tampered state and issues no session", async () => {
    const res = await ssoRoundTrip(
      { sub: `sub-tamper-${suffix}`, email: `tamper-${suffix}@example.com` },
      { tamperState: true },
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_exchange");
    expect(res.cookies.find((c) => c.name === "edc_session")).toBeUndefined();
  });

  it("refuses provisioning without an email claim", async () => {
    const res = await ssoRoundTrip({ sub: `sub-noemail-${suffix}` });
    expect(res.headers.location).toBe("/login?error=missing_email");
  });

  it("blocks password login when EDC_OIDC_ONLY is set", async () => {
    const ssoOnly = await buildServer({ db, authConfig: authConfig({ oidcOnly: true }) });
    await ssoOnly.ready();
    try {
      const res = await ssoOnly.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `local-${suffix}`, password: PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("password_login_disabled");
      const cfg = await ssoOnly.inject({ method: "GET", url: "/auth/config" });
      expect(cfg.json()).toMatchObject({ oidcOnly: true, passwordLoginEnabled: false });
    } finally {
      await ssoOnly.close();
    }
  });

  describe("e-signature re-authentication via IdP", () => {
    const fx = { formId: "", token: "", userId: "", sub: `sub-signer-${suffix}` };

    async function reauthGrant(claims: Record<string, unknown>): Promise<string | null> {
      const res = await ssoRoundTrip(claims, { purpose: "reauth" });
      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      const fragment = new URLSearchParams(location.split("#")[1] ?? "");
      return location.startsWith("/reauth-complete#grant=") ? fragment.get("grant") : null;
    }

    beforeAll(async () => {
      // SSO signer with the investigator role, one completed form.
      const login = await ssoRoundTrip({
        sub: fx.sub,
        email: `signer-${suffix}@example.com`,
        email_verified: true,
        name: "Dr Signer",
      });
      fx.token = sessionCookie(login);
      const me = await server.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { edc_session: fx.token },
      });
      fx.userId = me.json().id;

      const [study] = await db
        .insert(studies)
        .values({ oid: `ST.OIDC.${suffix}`, name: "OIDC Study" })
        .returning();
      if (!study) throw new Error("fixture failed");
      const [site] = await db
        .insert(sites)
        .values({ studyId: study.id, oid: "SITE.1", name: "Site" })
        .returning();
      if (!site) throw new Error("fixture failed");
      const [role] = await db.select().from(roles).where(eq(roles.name, "investigator"));
      if (!role) throw new Error("fixture failed");
      await grantRole(db, {
        userId: fx.userId,
        studyId: study.id,
        roleId: role.id,
        grantedBy: fx.userId,
      });
      const imported = await importStudyBuild(db, {
        studyId: study.id,
        content: ODM,
        actorId: fx.userId,
      });
      if (!imported.ok) throw new Error("import failed");

      const subject = (
        await server.inject({
          method: "POST",
          url: `/studies/${study.id}/subjects`,
          payload: { siteId: site.id, subjectKey: "S-001" },
          cookies: { edc_session: fx.token },
        })
      ).json();
      fx.formId = (
        await server.inject({
          method: "POST",
          url: `/subjects/${subject.id}/forms`,
          payload: { eventOid: "SE.V1", formOid: "FO.VS" },
          cookies: { edc_session: fx.token },
        })
      ).json().id;
      await server.inject({
        method: "PUT",
        url: `/forms/${fx.formId}/items`,
        payload: { itemGroupOid: "IG.VS", itemOid: "IT.HR", value: "72" },
        cookies: { edc_session: fx.token },
      });
      await server.inject({
        method: "POST",
        url: `/forms/${fx.formId}/status`,
        payload: { action: "complete" },
        cookies: { edc_session: fx.token },
      });
    });

    it("signs with a fresh-IdP-login grant, which is single-use", async () => {
      const grant = await reauthGrant({
        sub: fx.sub,
        email: `signer-${suffix}@example.com`,
        auth_time: Math.floor(Date.now() / 1000),
      });
      expect(grant).toBeTruthy();

      const signed = await server.inject({
        method: "POST",
        url: `/forms/${fx.formId}/sign`,
        payload: { reauthGrant: grant, meaning: "Investigator approval" },
        cookies: { edc_session: fx.token },
      });
      expect(signed.statusCode).toBe(201);

      const form = (
        await server.inject({
          method: "GET",
          url: `/forms/${fx.formId}`,
          cookies: { edc_session: fx.token },
        })
      ).json();
      expect(form.context.status).toBe("signed");
      expect(form.signatures[0].signerName).toBe("Dr Signer");

      // Reuse must fail: the grant was consumed by the signature above.
      await server.inject({
        method: "POST",
        url: `/forms/${fx.formId}/status`,
        payload: { action: "reopen" },
        cookies: { edc_session: fx.token },
      });
      await server.inject({
        method: "POST",
        url: `/forms/${fx.formId}/status`,
        payload: { action: "complete" },
        cookies: { edc_session: fx.token },
      });
      const reuse = await server.inject({
        method: "POST",
        url: `/forms/${fx.formId}/sign`,
        payload: { reauthGrant: grant, meaning: "Investigator approval" },
        cookies: { edc_session: fx.token },
      });
      expect(reuse.statusCode).toBe(403);
    });

    it("rejects a stale interactive login", async () => {
      const res = await ssoRoundTrip(
        {
          sub: fx.sub,
          email: `signer-${suffix}@example.com`,
          auth_time: Math.floor(Date.now() / 1000) - 3600,
        },
        { purpose: "reauth" },
      );
      expect(res.headers.location).toBe("/reauth-complete#error=stale_auth");
    });

    it("rejects re-auth for a subject with no account", async () => {
      const res = await ssoRoundTrip(
        {
          sub: `sub-stranger-${suffix}`,
          email: `stranger-${suffix}@example.com`,
          auth_time: Math.floor(Date.now() / 1000),
        },
        { purpose: "reauth" },
      );
      expect(res.headers.location).toBe("/reauth-complete#error=unknown_user");
    });

    it("someone else's grant cannot sign for the session user", async () => {
      // Fresh grant for the SSO signer, presented by a *different* signer.
      const grant = await reauthGrant({
        sub: fx.sub,
        email: `signer-${suffix}@example.com`,
        auth_time: Math.floor(Date.now() / 1000),
      });
      const [study] = await db
        .select()
        .from(studies)
        .where(eq(studies.oid, `ST.OIDC.${suffix}`));
      const [role] = await db.select().from(roles).where(eq(roles.name, "investigator"));
      const [other] = await db
        .insert(users)
        .values({
          username: `other-inv-${suffix}`,
          email: `other-inv-${suffix}@example.com`,
          fullName: "Dr Other",
          passwordHash: await hashPassword(PASSWORD),
        })
        .returning();
      if (!study || !role || !other) throw new Error("fixture failed");
      await grantRole(db, {
        userId: other.id,
        studyId: study.id,
        roleId: role.id,
        grantedBy: other.id,
      });
      const otherToken = (
        await server.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username: `other-inv-${suffix}`, password: PASSWORD },
        })
      ).json().token;

      const res = await server.inject({
        method: "POST",
        url: `/forms/${fx.formId}/sign`,
        payload: { reauthGrant: grant, meaning: "Investigator approval" },
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
