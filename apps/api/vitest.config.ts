import { defineConfig } from "vitest/config";
import { testDatabaseUrl } from "./src/test/database.js";
import { TEST_LAKE_DATA_PATH } from "./src/test/global-setup.js";

export default defineConfig({
  test: {
    // Redirect every DB consumer (drizzle client, migrations, DuckLake
    // catalog attach) away from the shared dev database and lake.
    env: {
      DATABASE_URL: testDatabaseUrl(),
      LAKE_DATA_PATH: TEST_LAKE_DATA_PATH,
    },
    globalSetup: "./src/test/global-setup.ts",
  },
});
