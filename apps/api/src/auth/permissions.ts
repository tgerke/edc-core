// Must stay in sync with the role seed in drizzle/0003_seed_roles.sql.
export const PERMISSIONS = [
  "study.manage",
  "subject.enroll",
  "data.enter",
  "data.verify",
  "data.sign",
  "data.lock",
  "query.manage",
  "query.answer",
  "audit.review",
  "export.data",
  "roles.grant",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
