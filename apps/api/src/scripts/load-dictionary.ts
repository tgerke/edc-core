// Loads a normalized dictionary CSV from the local filesystem, bypassing the
// HTTP upload's body limit — full WHODrug conversions can be too large for a
// comfortable JSON envelope. Same validation and audit as the API route.
//
//   pnpm --filter @edc-core/api db:load-dictionary -- \
//     --type MedDRA --version 27.1 --file /path/to/meddra.csv [--user admin]
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { users } from "../db/schema/index.js";
import { CaptureError } from "../services/capture.js";
import { loadDictionary } from "../services/dictionaries.js";

const { values } = parseArgs({
  options: {
    type: { type: "string" },
    version: { type: "string" },
    file: { type: "string" },
    user: { type: "string", default: "admin" },
  },
});

if ((values.type !== "MedDRA" && values.type !== "WHODrug") || !values.version || !values.file) {
  console.error(
    "usage: db:load-dictionary --type MedDRA|WHODrug --version <label> --file <csv> [--user <username>]",
  );
  process.exit(1);
}

await runMigrations();
const { db, client } = createDb();

try {
  const [actor] = await db.select().from(users).where(eq(users.username, values.user)).limit(1);
  if (!actor) {
    console.error(`user "${values.user}" not found`);
    process.exit(1);
  }
  if (!actor.isSystemAdmin) {
    console.error(`user "${values.user}" is not a system administrator`);
    process.exit(1);
  }

  const content = await readFile(values.file, "utf8");
  const dictionary = await loadDictionary(db, {
    type: values.type,
    version: values.version,
    content,
    actorId: actor.id,
  });
  console.log(
    `loaded ${values.type} ${values.version}: ${dictionary.termsCount} terms (id ${dictionary.id})`,
  );
} catch (err) {
  if (err instanceof CaptureError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
} finally {
  await client.end();
}
