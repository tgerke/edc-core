// Must stay in sync with the role seeds in drizzle/ (0003, plus the
// per-permission additions in 0006, 0010, 0012, 0013, 0014, 0022).
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
  "data.import",
  "data.code",
  "analytics.run",
  "data.unblind",
  "roles.grant",
  "integration.rtsm",
  "site.forms.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
