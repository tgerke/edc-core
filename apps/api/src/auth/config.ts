// Part 11-relevant knobs (P11-03, P11-12). Env-overridable so sponsors can
// match their SOPs; defaults are deliberately conservative.
export interface AuthConfig {
  passwordMinLength: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
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

export function loadAuthConfig(): AuthConfig {
  return {
    passwordMinLength: envInt("EDC_PASSWORD_MIN_LENGTH", 12),
    maxFailedLogins: envInt("EDC_MAX_FAILED_LOGINS", 5),
    lockoutMinutes: envInt("EDC_LOCKOUT_MINUTES", 15),
    sessionIdleMinutes: envInt("EDC_SESSION_IDLE_MINUTES", 30),
    sessionAbsoluteHours: envInt("EDC_SESSION_ABSOLUTE_HOURS", 8),
  };
}
