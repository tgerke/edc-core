// Creates the initial system administrator when no users exist.
// Idempotent: exits quietly if any user is already present.
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { loadAuthConfig } from "../auth/config.js";
import { hashPassword, validatePasswordPolicy } from "../auth/password.js";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, users } from "../db/schema/index.js";

await runMigrations();
const { db, client } = createDb();

try {
  const rows = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM users`);
  if ((rows[0]?.count ?? 0) > 0) {
    console.log("users already exist; skipping admin bootstrap");
    process.exit(0);
  }

  const username = process.env.EDC_ADMIN_USERNAME ?? "admin";
  const email = process.env.EDC_ADMIN_EMAIL ?? "admin@example.invalid";
  const generated = !process.env.EDC_ADMIN_PASSWORD;
  const password = process.env.EDC_ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");

  if (!generated) {
    const config = loadAuthConfig();
    const violation = validatePasswordPolicy(password, config.passwordMinLength);
    if (violation) {
      console.error(`EDC_ADMIN_PASSWORD rejected: ${violation}`);
      process.exit(1);
    }
  }

  const [admin] = await db
    .insert(users)
    .values({
      username,
      email,
      fullName: "System Administrator",
      passwordHash: await hashPassword(password),
      isSystemAdmin: true,
    })
    .returning();
  if (!admin) throw new Error("admin insert returned no row");

  await db.insert(auditEvents).values({
    actorId: admin.id,
    action: "user.bootstrap_admin",
    entityType: "user",
    entityId: admin.id,
    newValue: { username, email },
  });

  console.log(`created system admin "${username}"`);
  if (generated) {
    console.log(`generated password (shown once, store it now): ${password}`);
  }
} finally {
  await client.end();
}
