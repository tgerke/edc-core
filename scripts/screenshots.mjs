#!/usr/bin/env node
// Docs screenshot generator — reproduces every site/images/*.png against the
// dev stack, so a UI refresh is one command instead of an ad-hoc Playwright
// session. See CONTRIBUTING.md ("Refreshing docs screenshots") for the recipe.
//
// What it does, in order:
//   1. Brings up (or reuses) the compose stack from infra/compose.yaml.
//   2. Bootstraps the system admin and seeds the demo study (both idempotent).
//   3. Builds the remaining reference states: DEMO-003 registered in
//      screening, the repeating-groups demo study with an occurrence-2 edit
//      check finding, a published snapshot, SQL/R/Python workbench runs, an
//      auto-coding run (leaves "stomach ake" uncoded), and a failed-login
//      burst scanned into security-anomaly findings.
//   4. Captures each page at 1440x900, deviceScaleFactor 2, fullPage —
//      matching the existing 2880px-wide PNGs.
//
// The state setup is additive and idempotent, but the *pages* show whatever
// else is in the database: for canonical screenshots start from a fresh
// stack (`podman compose -f infra/compose.yaml down -v`).
//
// Usage: node scripts/screenshots.mjs [--only name,name] [--out dir]

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WEB_URL = process.env.EDC_WEB_URL ?? "http://localhost:5173";
const PASSWORD = process.env.EDC_DEMO_PASSWORD ?? "demo-Passw0rd-2026";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://edc:edc-dev-only@localhost:5432/edc";
const COMPOSE_TOOL = process.env.EDC_COMPOSE_TOOL ?? "podman";
const VIEWPORT = { width: 1440, height: 900 };

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const only = flagValue("--only")
  ?.split(",")
  .map((s) => s.trim());
const outDir = path.resolve(root, flagValue("--out") ?? "site/images");

// ---------------------------------------------------------------------------
// Reference states (recovered from the previous captures)

const DEMO_STUDY_OID = "ST.CDASH.DEMO";
const RPT_STUDY_OID = "ST.RPT.DEMO";

// Minimal study with a repeating section for repeating-entry.png: occurrence 1
// is clean, occurrence 2 (70/95) trips the BP-inverted check and opens a
// system query pinned to that occurrence.
const RPT_ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="${RPT_STUDY_OID}.v1" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-13T00:00:00Z" Granularity="Metadata">
  <Study OID="${RPT_STUDY_OID}" StudyName="Repeating Groups Demo">
    <MetaDataVersion OID="MDV.1" Name="Version 1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Blood Pressure Reading" Type="Section" Repeating="Simple">
        <ItemRef ItemOID="IT.VSDTC" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.SYSBP" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.DIABP" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.VSDTC" Name="Measurement time" DataType="datetime">
        <Question><TranslatedText xml:lang="en" Type="text/plain">When was the reading taken?</TranslatedText></Question>
      </ItemDef>
      <ItemDef OID="IT.SYSBP" Name="Systolic BP" DataType="integer">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Systolic blood pressure (mmHg)</TranslatedText></Question>
      </ItemDef>
      <ItemDef OID="IT.DIABP" Name="Diastolic BP" DataType="integer">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Diastolic blood pressure (mmHg)</TranslatedText></Question>
      </ItemDef>
      <ConditionDef OID="CHECK.BP_INVERTED" Name="BP inverted">
        <Description><TranslatedText xml:lang="en" Type="text/plain">Systolic BP must exceed diastolic BP</TranslatedText></Description>
        <FormalExpression Context="jsonata">\`IT.SYSBP\` != null and \`IT.DIABP\` != null and \`IT.SYSBP\` &lt;= \`IT.DIABP\`</FormalExpression>
      </ConditionDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

// The documented workbench examples (site/guide/analytics.qmd) against the
// demo snapshot's ig_vs table.
const SQL_EXAMPLE = `SELECT subject_key, it_vs_sysbp, it_vs_diabp,
       it_vs_sysbp - it_vs_diabp AS pulse_pressure
FROM ig_vs
ORDER BY subject_key`;
const R_EXAMPLE = `vs <- lake_read("ig_vs")
summary(vs$it_vs_sysbp)
lake_query("SELECT subject_key, it_vs_sysbp, it_vs_diabp FROM ig_vs ORDER BY subject_key")`;
const PY_EXAMPLE = `vs = lake_read("ig_vs")
print(vs["it_vs_sysbp"].describe())
lake_query("SELECT subject_key, it_vs_sysbp, it_vs_diabp FROM ig_vs ORDER BY subject_key")`;

// ---------------------------------------------------------------------------
// Helpers

function log(message) {
  console.log(`▸ ${message}`);
}

function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL, ...opts.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} exited with ${result.status}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function webReachable() {
  try {
    const res = await fetch(`${WEB_URL}/api/auth/config`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureStack() {
  if (await webReachable()) {
    log(`dev stack already up at ${WEB_URL}`);
    return;
  }
  log(`dev stack not reachable at ${WEB_URL} — starting it (${COMPOSE_TOOL} compose)`);
  run(COMPOSE_TOOL, ["compose", "-f", "infra/compose.yaml", "up", "-d", "--build"]);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (await webReachable()) return;
    await sleep(3000);
  }
  throw new Error(`stack did not become reachable at ${WEB_URL} within 10 minutes`);
}

// JSON wrapper around a Playwright APIRequestContext that shares the browser
// context's session cookie.
function api(request) {
  const call = async (method, apiPath, data) => {
    const res = await request.fetch(`${WEB_URL}/api${apiPath}`, {
      method,
      ...(data !== undefined ? { data } : {}),
    });
    const body = await res.text();
    if (!res.ok()) {
      throw new Error(`${method} ${apiPath} → ${res.status()}: ${body.slice(0, 300)}`);
    }
    return body ? JSON.parse(body) : null;
  };
  return {
    get: (p) => call("GET", p),
    post: (p, data) => call("POST", p, data ?? {}),
    put: (p, data) => call("PUT", p, data),
  };
}

// ---------------------------------------------------------------------------
// State setup (all steps idempotent)

function bootstrapAndSeed() {
  log("bootstrapping system admin + seeding demo study (idempotent)");
  run("pnpm", ["--filter", "@edc-core/api", "db:bootstrap-admin"], {
    env: { EDC_ADMIN_PASSWORD: PASSWORD },
  });
  run("pnpm", ["--filter", "@edc-core/api", "db:seed-demo"], {
    env: { EDC_DEMO_PASSWORD: PASSWORD },
  });
}

async function ensureDemoSubject(coord, demoStudyId, siteId) {
  const subjects = await coord.get(`/studies/${demoStudyId}/subjects`);
  if (subjects.some((s) => s.subjectKey === "DEMO-003")) return;
  log("registering DEMO-003 in screening");
  await coord.post(`/studies/${demoStudyId}/subjects`, {
    siteId,
    subjectKey: "DEMO-003",
    status: "screening",
  });
}

async function ensureRptStudy(admin, coord) {
  const coordStudies = await coord.get("/studies");
  let study = coordStudies.find((s) => s.oid === RPT_STUDY_OID);
  if (!study) {
    log(`creating ${RPT_STUDY_OID} (repeating item-group demo)`);
    study = await admin.post("/studies", { oid: RPT_STUDY_OID, name: "Repeating Groups Demo" });
    const site = await admin.post(`/studies/${study.id}/sites`, {
      oid: "SITE.001",
      name: "Tampa General Hospital",
    });
    // The build import needs study.manage, which system administration
    // deliberately does not imply — grant the study-scoped admin role first.
    const users = await admin.get("/admin/users");
    const userId = (username) => {
      const user = users.find((u) => u.username === username);
      if (!user) throw new Error(`expected seeded user ${username}`);
      return user.id;
    };
    const me = await admin.get("/auth/me");
    await admin.post(`/studies/${study.id}/roles`, { userId: me.id, roleName: "admin" });
    await admin.post(`/studies/${study.id}/metadata-versions`, { content: RPT_ODM });
    await admin.post(`/studies/${study.id}/roles`, {
      userId: userId("demo-coord"),
      roleName: "data_entry",
      siteId: site.id,
    });
  }

  const subjects = await coord.get(`/studies/${study.id}/subjects`);
  let subject = subjects.find((s) => s.subjectKey === "RPT-001");
  if (!subject) {
    const sites = await coord.get(`/studies/${study.id}/sites`);
    subject = await coord.post(`/studies/${study.id}/subjects`, {
      siteId: sites[0].id,
      subjectKey: "RPT-001",
    });
  }
  const form = await coord.post(`/subjects/${subject.id}/forms`, {
    eventOid: "SE.V1",
    formOid: "FO.VS",
  });
  const { values } = await coord.get(`/forms/${form.id}`);
  if (values.length === 0) {
    log("entering RPT-001 blood-pressure occurrences (occurrence 2 trips the edit check)");
    const readings = [
      [1, "IT.SYSBP", "120"],
      [1, "IT.DIABP", "80"],
      [2, "IT.SYSBP", "70"],
      [2, "IT.DIABP", "95"],
    ];
    for (const [itemGroupRepeatKey, itemOid, value] of readings) {
      await coord.put(`/forms/${form.id}/items`, {
        itemGroupOid: "IG.VS",
        itemGroupRepeatKey,
        itemOid,
        value,
      });
    }
  }
  return form.id;
}

async function ensureSnapshot(dm, demoStudyId) {
  const { snapshots } = await dm.get(`/studies/${demoStudyId}/snapshots`);
  const published = snapshots.filter((s) => s.status === "published");
  if (published.length > 0) return published[0].id;
  log("publishing demo snapshot");
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const snapshot = await dm.post(`/studies/${demoStudyId}/snapshots`, {
    note: `v${version} demo snapshot`,
  });
  return snapshot.id;
}

// Pre-populates the execution history shown on the workbench screenshots;
// skipped when history exists so re-runs don't pile up identical entries
// (the UI-driven runs during capture still add one apiece).
async function runWorkbenchExamples(dm, demoStudyId, snapshotId) {
  const { executions } = await dm.get(`/studies/${demoStudyId}/workbench/executions`);
  if (executions.length > 0) return;
  log("running documented SQL/R/Python workbench examples");
  await dm.post(`/studies/${demoStudyId}/workbench/sql`, { snapshotId, sql: SQL_EXAMPLE });
  await dm.post(`/studies/${demoStudyId}/workbench/r`, { snapshotId, content: R_EXAMPLE });
  await dm.post(`/studies/${demoStudyId}/workbench/python`, { snapshotId, content: PY_EXAMPLE });
}

async function ensureCodingRun(dm, demoStudyId) {
  const runs = await dm.get(`/studies/${demoStudyId}/coding/runs`);
  if (runs.some((r) => r.status?.startsWith("completed"))) return;
  log('starting auto-coding run ("stomach ake" stays uncoded)');
  const { runId } = await dm.post(`/studies/${demoStudyId}/coding/runs`);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const runRow = await dm.get(`/studies/${demoStudyId}/coding/runs/${runId}`);
    if (runRow.status !== "running") {
      if (runRow.status === "failed") throw new Error("auto-coding run failed");
      return;
    }
    await sleep(1000);
  }
  throw new Error("auto-coding run did not finish within 5 minutes");
}

// Failed-login burst: ≥ EDC_ANOMALY_FAILED_LOGIN_THRESHOLD (default 10) 401s
// from one source IP inside the scan window. A nonexistent username keeps the
// demo accounts clear of the per-account lockout. The detection scan normally
// runs on the API's 15-minute scheduler tick; invoke it directly so the
// findings exist right away (dedupe keys make the double scan a no-op).
async function ensureAnomalies(playwright, admin) {
  const open = await admin.get("/admin/security-anomalies?status=open&kind=failed_login_burst");
  if (open.total > 0) return;
  log("generating failed-login burst + running the anomaly scan");
  const anonymous = await playwright.request.newContext();
  try {
    for (let i = 0; i < 12; i++) {
      await anonymous.post(`${WEB_URL}/api/auth/login`, {
        data: { username: "intruder", password: "not-the-password" },
      });
    }
  } finally {
    await anonymous.dispose();
  }

  const scanDir = mkdtempSync(path.join(tmpdir(), "edc-anomaly-scan-"));
  const scanFile = path.join(scanDir, "scan.mts");
  const moduleUrl = (p) => pathToFileURL(path.join(root, p)).href;
  writeFileSync(
    scanFile,
    `const { createDb } = await import(${JSON.stringify(moduleUrl("apps/api/src/db/client.ts"))});
const { loadAnomalyConfig, scanSecurityAnomalies } = await import(${JSON.stringify(
      moduleUrl("apps/api/src/services/security-anomalies.ts"),
    )});
const { db, client } = createDb();
try {
  const found = await scanSecurityAnomalies(db, loadAnomalyConfig());
  console.log(\`anomaly scan: \${found} new finding(s)\`);
} finally {
  await client.end();
}
`,
  );
  try {
    run("pnpm", ["--filter", "@edc-core/api", "exec", "tsx", scanFile]);
  } finally {
    rmSync(scanDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Capture

async function shoot(page, name) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const file = path.join(outDir, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
  } catch {
    // fullPage exceeds Chromium's texture limit when leftover dev data makes
    // a page extremely tall; fall back to the viewport rather than failing.
    log(`${name}: full-page capture too tall (leftover dev data?) — using viewport only`);
    await page.screenshot({ path: file });
  }
  log(`captured ${path.relative(root, file)}`);
}

async function main() {
  await ensureStack();
  bootstrapAndSeed();

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "playwright is not installed — run `pnpm install` and `npx playwright install chromium`",
    );
  }
  const browser = await chromium.launch();
  const playwright = await import("playwright");

  const newContext = () =>
    browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, baseURL: WEB_URL });

  // One authenticated context per persona, so each page shows the user who
  // would realistically be on it.
  const login = async (username) => {
    const context = await newContext();
    const res = await context.request.post(`${WEB_URL}/api/auth/login`, {
      data: { username, password: PASSWORD },
    });
    if (!res.ok()) {
      await context.close();
      return null;
    }
    return context;
  };

  try {
    // System admin: `admin` exists on a stack this script bootstrapped fresh;
    // fall back to any demo login that was promoted to system admin.
    let adminCtx = await login("admin");
    if (adminCtx && !(await api(adminCtx.request).get("/auth/me")).isSystemAdmin) {
      await adminCtx.close();
      adminCtx = null;
    }
    if (!adminCtx) {
      adminCtx = await login("demo-admin");
      if (adminCtx && !(await api(adminCtx.request).get("/auth/me")).isSystemAdmin) {
        await adminCtx.close();
        adminCtx = null;
      }
    }
    if (!adminCtx) {
      throw new Error(
        "no system-admin login available — start from a fresh stack " +
          "(`podman compose -f infra/compose.yaml down -v`) so bootstrap-admin can run",
      );
    }
    const dmCtx = await login("demo-dm");
    const coordCtx = await login("demo-coord");
    const demoAdminCtx = await login("demo-admin");
    if (!dmCtx || !coordCtx || !demoAdminCtx) {
      throw new Error(`demo logins failed — is EDC_DEMO_PASSWORD correct? (tried "${PASSWORD}")`);
    }
    const admin = api(adminCtx.request);
    const dm = api(dmCtx.request);
    const coord = api(coordCtx.request);

    // -- state --------------------------------------------------------------
    const demoStudy = (await dm.get("/studies")).find((s) => s.oid === DEMO_STUDY_OID);
    if (!demoStudy) throw new Error(`seeded study ${DEMO_STUDY_OID} not found`);
    const sites = await coord.get(`/studies/${demoStudy.id}/sites`);
    const site1 = sites.find((s) => s.oid === "SITE.001");

    await ensureDemoSubject(coord, demoStudy.id, site1.id);
    const rptFormId = await ensureRptStudy(admin, coord);
    // Coding before the snapshot so the snapshot's codings table has rows.
    await ensureCodingRun(dm, demoStudy.id);
    const snapshotId = await ensureSnapshot(dm, demoStudy.id);
    await runWorkbenchExamples(dm, demoStudy.id, snapshotId);
    await ensureAnomalies(playwright, admin);

    const matrix = await coord.get(`/studies/${demoStudy.id}/matrix`);
    const demo002 = matrix.subjects.find((s) => s.subjectKey === "DEMO-002");
    const vsFormId = demo002?.cells["SE.SCREENING:FO.VS"]?.formInstanceId;
    if (!vsFormId) throw new Error("DEMO-002 vitals form not found in matrix");
    const builds = await dm.get(`/studies/${demoStudy.id}/metadata-versions`);
    const buildVersion = Math.max(...builds.map((b) => b.version));

    // -- shots --------------------------------------------------------------
    mkdirSync(outDir, { recursive: true });
    const shots = [
      {
        name: "login",
        context: null,
        async run(page) {
          await page.goto("/login");
          await page.locator("#username").waitFor();
        },
      },
      {
        name: "studies",
        context: dmCtx,
        async run(page) {
          await page.goto("/studies");
          await page.getByText("edc-core Demo Study").first().waitFor();
        },
      },
      {
        name: "study-overview",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}`);
          await page.getByText("edc-core Demo Study").first().waitFor();
        },
      },
      {
        name: "study-builder",
        context: demoAdminCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/builds/${buildVersion}`);
          await page.getByRole("button", { name: "Vital Signs" }).first().click();
          await page.getByText("What was the systolic blood pressure?").first().waitFor();
        },
      },
      {
        name: "study-builder-edit",
        context: demoAdminCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/builds/${buildVersion}`);
          await page.getByRole("button", { name: "Vital Signs" }).first().click();
          await page.getByText("What was the systolic blood pressure?").first().waitFor();
          await page.getByRole("button", { name: "Edit build" }).click();
          await page.getByRole("button", { name: "Edit", exact: true }).first().click();
        },
      },
      {
        name: "subject-matrix",
        context: coordCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/subjects`);
          await page.getByText("DEMO-003").first().waitFor();
        },
      },
      {
        name: "form-entry",
        context: coordCtx,
        async run(page) {
          await page.goto(`/forms/${vsFormId}`);
          await page.getByText("open query").first().waitFor();
        },
      },
      {
        name: "repeating-entry",
        context: coordCtx,
        async run(page) {
          await page.goto(`/forms/${rptFormId}`);
          await page.getByText("occurrence 2").first().waitFor();
        },
      },
      {
        name: "queries",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/queries`);
          await page.getByText("DEMO-002").first().waitFor();
        },
      },
      {
        name: "coding",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/coding`);
          await page.getByRole("cell", { name: "stomach ake" }).first().waitFor();
        },
      },
      {
        name: "audit-trail",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/audit`);
        },
      },
      {
        name: "team",
        context: demoAdminCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/team`);
          await page.getByText("demo-coord").first().waitFor();
        },
      },
      {
        name: "workbench-sql",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/workbench`);
          await page.locator("#snapshot-select").waitFor();
          await page.locator("textarea").fill(SQL_EXAMPLE);
          await page.getByRole("button", { name: "Run (⌘⏎)" }).click();
          await page.getByText("· snapshot v").waitFor({ timeout: 60_000 });
        },
      },
      {
        name: "workbench-r",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/workbench`);
          await page.locator("#snapshot-select").waitFor();
          await page.getByRole("button", { name: "R", exact: true }).click();
          await page.locator("textarea").fill(R_EXAMPLE);
          await page.getByRole("button", { name: "Run (⌘⏎)" }).click();
          await page.getByText("succeeded ·").first().waitFor({ timeout: 180_000 });
        },
      },
      {
        name: "workbench-python",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/workbench`);
          await page.locator("#snapshot-select").waitFor();
          await page.getByRole("button", { name: "Python", exact: true }).click();
          await page.locator("textarea").fill(PY_EXAMPLE);
          await page.getByRole("button", { name: "Run (⌘⏎)" }).click();
          await page.getByText("succeeded ·").first().waitFor({ timeout: 180_000 });
        },
      },
      {
        name: "users-admin",
        context: adminCtx,
        async run(page) {
          await page.goto("/admin/users");
          await page.getByText("demo-coord").first().waitFor();
        },
      },
      {
        name: "access-log",
        context: adminCtx,
        async run(page) {
          await page.goto("/admin/access-log");
          await page.getByText("GET /").first().waitFor();
        },
      },
      {
        name: "anomalies",
        context: adminCtx,
        async run(page) {
          await page.goto("/admin/anomalies");
          await page.getByText("Failed-login burst").first().waitFor();
        },
      },
    ];

    for (const shot of shots) {
      if (only && !only.includes(shot.name)) continue;
      const context = shot.context ?? (await newContext());
      const page = await context.newPage();
      try {
        await shot.run(page);
        await shoot(page, shot.name);
      } finally {
        await page.close();
        if (!shot.context) await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  log("done");
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
