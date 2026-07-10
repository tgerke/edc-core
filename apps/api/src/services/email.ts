import nodemailer from "nodemailer";

/**
 * Outbound email is optional: unset EDC_SMTP_HOST and notifications stay
 * in-app only. Plain text on purpose — these are pointers into the system,
 * not documents.
 */
export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** Web origin used to build deep links, e.g. https://edc.example.org */
  baseUrl: string;
}

export interface EmailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export function loadEmailConfig(): EmailConfig | null {
  const host = process.env.EDC_SMTP_HOST;
  if (!host) return null;
  const user = process.env.EDC_SMTP_USER;
  const pass = process.env.EDC_SMTP_PASS;
  return {
    host,
    port: Number.parseInt(process.env.EDC_SMTP_PORT ?? "587", 10),
    secure: process.env.EDC_SMTP_SECURE === "1" || process.env.EDC_SMTP_SECURE === "true",
    ...(user ? { user } : {}),
    ...(pass ? { pass } : {}),
    from: process.env.EDC_SMTP_FROM ?? "edc-core <no-reply@localhost>",
    baseUrl: process.env.EDC_BASE_URL ?? "http://localhost:5173",
  };
}

export function createEmailTransport(config: EmailConfig): EmailTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
  });
}
