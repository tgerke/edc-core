import { hash, verify } from "@node-rs/argon2";

export function validatePasswordPolicy(password: string, minLength: number): string | null {
  if (password.length < minLength) {
    return `Password must be at least ${minLength} characters`;
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classes < 3) {
    return "Password must contain at least three of: lowercase, uppercase, digits, symbols";
  }
  return null;
}

// OWASP-recommended argon2id parameters.
const ARGON2_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
