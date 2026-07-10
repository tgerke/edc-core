// Part 11-relevant knobs (P11-03, P11-12). Env-overridable so sponsors can
// match their SOPs; defaults are deliberately conservative.
export interface AuthConfig {
  passwordMinLength: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  oidc: OidcConfig | null;
  /** When true, POST /auth/login is disabled — SSO is the only way in. */
  oidcOnly: boolean;
}

// Single identity provider per deployment (authorization-code flow with
// PKCE). Presence of EDC_OIDC_ISSUER_URL enables SSO.
export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  providerLabel: string;
  /** Max age (seconds) of the IdP's auth_time accepted for signature re-auth. */
  reauthMaxAgeSeconds: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function envBool(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw === "true";
}

function requireEnv(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required when EDC_OIDC_ISSUER_URL is set`);
  return raw;
}

function loadOidcConfig(): OidcConfig | null {
  const issuerUrl = process.env.EDC_OIDC_ISSUER_URL;
  if (!issuerUrl) return null;
  return {
    issuerUrl,
    clientId: requireEnv("EDC_OIDC_CLIENT_ID"),
    clientSecret: requireEnv("EDC_OIDC_CLIENT_SECRET"),
    redirectUri: requireEnv("EDC_OIDC_REDIRECT_URI"),
    scopes: process.env.EDC_OIDC_SCOPES ?? "openid profile email",
    providerLabel: process.env.EDC_OIDC_PROVIDER_LABEL ?? "SSO",
    reauthMaxAgeSeconds: envInt("EDC_OIDC_REAUTH_MAX_AGE_SECONDS", 120),
  };
}

export function loadAuthConfig(): AuthConfig {
  const oidc = loadOidcConfig();
  const oidcOnly = envBool("EDC_OIDC_ONLY");
  if (oidcOnly && !oidc) {
    throw new Error("EDC_OIDC_ONLY requires EDC_OIDC_ISSUER_URL to be configured");
  }
  return {
    passwordMinLength: envInt("EDC_PASSWORD_MIN_LENGTH", 12),
    maxFailedLogins: envInt("EDC_MAX_FAILED_LOGINS", 5),
    lockoutMinutes: envInt("EDC_LOCKOUT_MINUTES", 15),
    sessionIdleMinutes: envInt("EDC_SESSION_IDLE_MINUTES", 30),
    sessionAbsoluteHours: envInt("EDC_SESSION_ABSOLUTE_HOURS", 8),
    oidc,
    oidcOnly,
  };
}
