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
//      auto-coding run (leaves "stomach ake" uncoded), a failed-login
//      burst scanned into security-anomaly findings, a manual query on
//      DEMO-001's vitals (which also lights demo-inv's notification bell),
//      a draft + a submitted site form layout for SITE.001, a lab-import
//      mapping, the amendment demo study (v1 data + a v2 build, never
//      migrated), the blinded dosing demo study (RTSM-configured, one
//      assignment applied through a minted API key), and the USDM protocol
//      demo study (imported, never published).
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
const AMD_STUDY_OID = "ST.AMD.DEMO";
const BLD_STUDY_OID = "ST.BLD.DEMO";
const USDM_STUDY_OID = "ST.USDM.DEMO";

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

// Amendment demo (amendments-diff / amendments-impact): v1 collects weight,
// v2 removes it (orphaned values), adds SpO2, and adds an edit check — so the
// diff and impact report each have something to show. The migration is never
// executed, keeping the panel in its pre-migration state across re-runs.
const AMD_ODM_V1 = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="${AMD_STUDY_OID}.v1" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-13T00:00:00Z" Granularity="Metadata">
  <Study OID="${AMD_STUDY_OID}" StudyName="Amendment Demo">
    <MetaDataVersion OID="MDV.1" Name="Version 1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Vital Signs" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.SYSBP" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.DIABP" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.WEIGHT" Mandatory="No"/>
      </ItemGroupDef>
      <ItemDef OID="IT.SYSBP" Name="Systolic BP" DataType="integer">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Systolic blood pressure (mmHg)</TranslatedText></Question>
      </ItemDef>
      <ItemDef OID="IT.DIABP" Name="Diastolic BP" DataType="integer">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Diastolic blood pressure (mmHg)</TranslatedText></Question>
      </ItemDef>
      <ItemDef OID="IT.WEIGHT" Name="Weight" DataType="float">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Weight (kg)</TranslatedText></Question>
      </ItemDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

const AMD_ODM_V2 = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="${AMD_STUDY_OID}.v2" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-14T00:00:00Z" Granularity="Metadata">
  <Study OID="${AMD_STUDY_OID}" StudyName="Amendment Demo">
    <MetaDataVersion OID="MDV.2" Name="Version 2 (protocol amendment 1)">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Vital Signs" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.SYSBP" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.DIABP" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.SPO2" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.SYSBP" Name="Systolic BP" DataType="integer">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Systolic blood pressure (mmHg)</TranslatedText></Question>
      </ItemDef>
      <ItemDef OID="IT.DIABP" Name="Diastolic BP" DataType="integer">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Diastolic blood pressure (mmHg)</TranslatedText></Question>
      </ItemDef>
      <ItemDef OID="IT.SPO2" Name="Oxygen saturation" DataType="integer">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Oxygen saturation (%)</TranslatedText></Question>
      </ItemDef>
      <ConditionDef OID="CHECK.SPO2_RANGE" Name="SpO2 plausible range">
        <Description><TranslatedText xml:lang="en" Type="text/plain">Oxygen saturation should be between 70 and 100</TranslatedText></Description>
        <FormalExpression Context="jsonata">\`IT.SPO2\` != null and (\`IT.SPO2\` &lt; 70 or \`IT.SPO2\` &gt; 100)</FormalExpression>
      </ConditionDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

// Blinded dosing demo (blinded-entry / blinded-field / break-blind /
// rtsm-panel): the assigned arm carries edc:Blinded, so site staff see it and
// the monitor sees [BLINDED]. The arm value itself arrives through the RTSM
// intake, exercising the API-key path end to end.
const BLD_ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
    FileOID="${BLD_STUDY_OID}.v1" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-13T00:00:00Z" Granularity="Metadata">
  <Study OID="${BLD_STUDY_OID}" StudyName="Blinded Dosing Demo">
    <MetaDataVersion OID="MDV.1" Name="Version 1">
      <StudyEventDef OID="SE.D1" Name="Day 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.DOSE" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.DOSE" Name="Randomization &amp; Dosing" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.DOSE" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.DOSE" Name="Randomization &amp; Dosing" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.ARM" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.DOSEMG" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.DOSEDTC" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.ARM" Name="Assigned arm" DataType="text" edc:Blinded="Yes">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Treatment arm assigned by the RTSM</TranslatedText></Question>
      </ItemDef>
      <ItemDef OID="IT.DOSEMG" Name="Dose administered" DataType="integer">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Dose administered (mg)</TranslatedText></Question>
      </ItemDef>
      <ItemDef OID="IT.DOSEDTC" Name="Dosing date" DataType="date">
        <Question><TranslatedText xml:lang="en" Type="text/plain">Date of first dose</TranslatedText></Question>
      </ItemDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

// Lab-import validation demo (lab-import): mixed row outcomes against the
// demo study — DEMO-001's completed form is skipped, DEMO-002's differing
// systolic reports a conflict, and DEMO-003's rows would create a form.
// Validation is a dry run, so nothing is ever written.
const LAB_MAPPING_NAME = "Central Lab";
const LAB_MAPPING_CONFIG = {
  formOid: "FO.VS",
  columns: {
    subjectKey: "USUBJID",
    siteOid: "SITEID",
    visit: "VISIT",
    testCode: "LBTESTCD",
    result: "LBORRES",
    collectionDate: "LBDTC",
  },
  visitMap: { SCREENING: "SE.SCREENING" },
  tests: {
    SYSBP: { itemGroupOid: "IG.VS", itemOid: "IT.VS.SYSBP" },
    DIABP: { itemGroupOid: "IG.VS", itemOid: "IT.VS.DIABP" },
  },
  collectionDateItem: { itemGroupOid: "IG.VS", itemOid: "IT.VS.VSDTC" },
};
const LAB_CSV = `USUBJID,SITEID,VISIT,LBTESTCD,LBORRES,LBDTC
DEMO-001,SITE.001,SCREENING,SYSBP,118,2026-07-01
DEMO-002,SITE.001,SCREENING,SYSBP,121,2026-07-01
DEMO-002,SITE.001,SCREENING,DIABP,78,2026-07-01
DEMO-003,SITE.001,SCREENING,SYSBP,117,2026-07-02
DEMO-003,SITE.001,SCREENING,DIABP,76,2026-07-02
`;

// Manual query on DEMO-001's completed vitals form (queries / notifications-
// bell): opened by demo-dm, so demo-inv and demo-coord get the notification.
const MANUAL_QUERY_BODY =
  "Please verify the diastolic value against the source document.";

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

// Demographics for dynamic-fields.png (ADR-0014): record a pregnancy test
// while the subject is female, then correct sex to male — leaving the
// retained value in its "not collected" state with the residual system
// query open. Idempotent: a stored IT.DM.PREG value means a prior run
// already staged the state.
async function ensureDynamicFieldsForm(coord, studyId) {
  const subjects = await coord.get(`/studies/${studyId}/subjects`);
  const subject = subjects.find((s) => s.subjectKey === "DEMO-002");
  if (!subject) throw new Error("seeded subject DEMO-002 not found");
  const form = await coord.post(`/subjects/${subject.id}/forms`, {
    eventOid: "SE.SCREENING",
    formOid: "FO.DM",
  });
  const { values } = await coord.get(`/forms/${form.id}`);
  if (!values.some((v) => v.item_oid === "IT.DM.PREG" && v.value !== null)) {
    log("staging DEMO-002 demographics (retained pregnancy value → not collected)");
    const writes = [
      { itemOid: "IT.DM.SEX", value: "2" },
      { itemOid: "IT.DM.PREG", value: "1" },
      { itemOid: "IT.DM.SEX", value: "1", reasonForChange: "transcription error" },
    ];
    for (const write of writes) {
      await coord.put(`/forms/${form.id}/items`, { itemGroupOid: "IG.DM", ...write });
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

// A study created by the system admin, with the admin granted the
// study-scoped admin role (system administration deliberately confers no
// clinical capability, so the grant is what makes builds importable).
async function ensureStudyWithSite(admin, oid, name) {
  const studies = await admin.get("/studies");
  let study = studies.find((s) => s.oid === oid);
  let site;
  let created = false;
  if (study) {
    const sites = await admin.get(`/studies/${study.id}/sites`);
    site = sites[0];
  } else {
    log(`creating ${oid} (${name})`);
    study = await admin.post("/studies", { oid, name });
    site = await admin.post(`/studies/${study.id}/sites`, {
      oid: "SITE.001",
      name: "Tampa General Hospital",
    });
    const me = await admin.get("/auth/me");
    await admin.post(`/studies/${study.id}/roles`, { userId: me.id, roleName: "admin" });
    created = true;
  }
  // The study-admin persona used by the capture contexts; granted on every
  // run (not just creation) so re-runs converge.
  await grantDemoRole(admin, study.id, "demo-admin", "admin");
  return { study, site, created };
}

async function grantDemoRole(admin, studyId, username, roleName, siteId) {
  const users = await admin.get("/admin/users");
  const user = users.find((u) => u.username === username);
  if (!user) throw new Error(`expected seeded user ${username}`);
  try {
    await admin.post(`/studies/${studyId}/roles`, {
      userId: user.id,
      roleName,
      ...(siteId ? { siteId } : {}),
    });
  } catch (err) {
    // An identical grant already existing is the idempotent success case.
    if (!/→ 409/.test(err.message)) throw err;
  }
}

// Amendment demo study: two subjects with v1 data (including the weight item
// v2 removes), then the v2 build — so the Amendments panel shows a diff with
// added/removed items and an impact report with eligible forms, orphaned
// values, and a check that will re-run. The migration is never executed.
async function ensureAmendmentStudy(admin, coord) {
  const { study, site, created } = await ensureStudyWithSite(
    admin,
    AMD_STUDY_OID,
    "Amendment Demo",
  );
  if (created) {
    await admin.post(`/studies/${study.id}/metadata-versions`, { content: AMD_ODM_V1 });
    await grantDemoRole(admin, study.id, "demo-coord", "data_entry", site.id);
  }

  const subjects = await coord.get(`/studies/${study.id}/subjects`);
  const entries = [
    ["AMD-001", "128", "82", "71.4"],
    ["AMD-002", "115", "74", "88.0"],
  ];
  for (const [subjectKey, sysbp, diabp, weight] of entries) {
    let subject = subjects.find((s) => s.subjectKey === subjectKey);
    if (!subject) {
      subject = await coord.post(`/studies/${study.id}/subjects`, {
        siteId: site.id,
        subjectKey,
      });
    }
    const form = await coord.post(`/subjects/${subject.id}/forms`, {
      eventOid: "SE.V1",
      formOid: "FO.VS",
    });
    const { values } = await coord.get(`/forms/${form.id}`);
    if (values.every((v) => v.value === null)) {
      log(`entering ${subjectKey} v1 vitals (amendment demo)`);
      for (const [itemOid, value] of [
        ["IT.SYSBP", sysbp],
        ["IT.DIABP", diabp],
        ["IT.WEIGHT", weight],
      ]) {
        await coord.put(`/forms/${form.id}/items`, { itemGroupOid: "IG.VS", itemOid, value });
      }
    }
  }

  const versions = await admin.get(`/studies/${study.id}/metadata-versions`);
  if (versions.length < 2) {
    log("importing amendment demo v2 (removes weight, adds SpO2 + a check)");
    await admin.post(`/studies/${study.id}/metadata-versions`, { content: AMD_ODM_V2 });
  }
  return study.id;
}

// Blinded dosing demo: the arm item is edc:Blinded, the coordinator enters
// the dose, and the arm itself arrives through the RTSM intake using a
// minted study-scoped API key. demo-cra is granted monitor (no data.unblind)
// so the same form shows [BLINDED] in their context.
async function ensureBlindedStudy(playwright, admin, coord) {
  const { study, site, created } = await ensureStudyWithSite(
    admin,
    BLD_STUDY_OID,
    "Blinded Dosing Demo",
  );
  if (created) {
    await admin.post(`/studies/${study.id}/metadata-versions`, { content: BLD_ODM });
    await grantDemoRole(admin, study.id, "demo-coord", "data_entry", site.id);
    await grantDemoRole(admin, study.id, "demo-inv", "investigator", site.id);
    await grantDemoRole(admin, study.id, "demo-cra", "monitor");
  }

  const subjects = await coord.get(`/studies/${study.id}/subjects`);
  let subject = subjects.find((s) => s.subjectKey === "BLD-001");
  if (!subject) {
    subject = await coord.post(`/studies/${study.id}/subjects`, {
      siteId: site.id,
      subjectKey: "BLD-001",
    });
  }
  const form = await coord.post(`/subjects/${subject.id}/forms`, {
    eventOid: "SE.D1",
    formOid: "FO.DOSE",
  });
  const { values } = await coord.get(`/forms/${form.id}`);
  if (!values.some((v) => v.item_oid === "IT.DOSEMG" && v.value !== null)) {
    log("entering BLD-001 dosing (blinded demo)");
    for (const [itemOid, value] of [
      ["IT.DOSEMG", "25"],
      ["IT.DOSEDTC", "2026-07-10"],
    ]) {
      await coord.put(`/forms/${form.id}/items`, { itemGroupOid: "IG.DOSE", itemOid, value });
    }
  }

  const config = await admin.get(`/studies/${study.id}/rtsm/config`);
  if (!config) {
    log("configuring RTSM intake for the blinded demo");
    await admin.put(`/studies/${study.id}/rtsm/config`, {
      eventOid: "SE.D1",
      formOid: "FO.DOSE",
      itemGroupOid: "IG.DOSE",
      itemOid: "IT.ARM",
      enabled: true,
    });
  }

  const events = await admin.get(`/studies/${study.id}/rtsm/events`);
  if (events.length === 0) {
    log("minting an RTSM API key and posting BLD-001's arm assignment");
    const minted = await admin.post(`/studies/${study.id}/rtsm/keys`, {
      label: "Docs demo RTSM",
    });
    const rtsm = await playwright.request.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${minted.token}` },
    });
    try {
      const res = await rtsm.post(`${WEB_URL}/api/studies/${study.id}/rtsm/assignments`, {
        data: {
          subjectKey: "BLD-001",
          arm: "ARM-B",
          randomizationId: "R-2026-0042",
          assignedAt: "2026-07-10T09:30:00Z",
          strata: { region: "US" },
          source: "vendor-rtsm",
        },
      });
      if (res.status() !== 201 && res.status() !== 200) {
        throw new Error(`RTSM assignment failed: ${res.status()} ${await res.text()}`);
      }
    } finally {
      await rtsm.dispose();
    }
  }
  return { studyId: study.id, formId: form.id };
}

// USDM protocol demo: import the shipped example package into its own study
// and stop before publishing, so the review screen shows the compiled
// schedule of activities in its reviewable state.
async function ensureProtocolStudy(admin) {
  const { study, created } = await ensureStudyWithSite(admin, USDM_STUDY_OID, "USDM Protocol Demo");
  if (created) {
    log("importing examples/demo-protocol-usdm.json (never published)");
    const content = readFileSync(path.join(root, "examples/demo-protocol-usdm.json"), "utf8");
    await admin.post(`/studies/${study.id}/protocol-versions`, {
      content,
      note: "Imported for docs screenshots",
    });
  }
  return study.id;
}

// Manual query on DEMO-001's completed vitals form. Opening it notifies the
// site staff who can answer (demo-inv, demo-coord) — which is exactly what
// the notifications-bell shot shows.
async function ensureManualQuery(dm, formInstanceId) {
  const queries = await dm.get(`/forms/${formInstanceId}/queries`);
  if (JSON.stringify(queries).includes(MANUAL_QUERY_BODY)) return;
  log("opening a manual query on DEMO-001's vitals");
  await dm.post(`/forms/${formInstanceId}/queries`, {
    body: MANUAL_QUERY_BODY,
    itemGroupOid: "IG.VS",
    itemOid: "IT.VS.DIABP",
  });
}

// Two site layouts for SITE.001: a draft (so the editor shot shows the live
// data-equivalence panel) and a submitted one (so the sponsor approval queue
// has an entry to decide).
async function ensureSiteLayouts(coord, studyId, siteId) {
  // Seed from the screening event only: the demo study's Common events
  // (AE, CM) carry no seedable forms and would fail variant validation.
  const seedEventOids = ["SE.SCREENING"];
  const variants = await coord.get(`/studies/${studyId}/sites/${siteId}/form-variants`);
  if (!variants.some((v) => v.name === "Clinic flow")) {
    log('creating draft site layout "Clinic flow"');
    await coord.post(`/studies/${studyId}/sites/${siteId}/form-variants`, {
      name: "Clinic flow",
      seedEventOids,
    });
  }
  const submitted = variants.find((v) => v.name === "Two-room screening");
  if (!submitted) {
    log('creating + submitting site layout "Two-room screening"');
    const createdVariant = await coord.post(`/studies/${studyId}/sites/${siteId}/form-variants`, {
      name: "Two-room screening",
      seedEventOids,
    });
    await coord.post(
      `/studies/${studyId}/sites/${siteId}/form-variants/versions/${createdVariant.versionId}/submit`,
    );
  } else if (submitted.latest?.status === "draft") {
    await coord.post(
      `/studies/${studyId}/sites/${siteId}/form-variants/versions/${submitted.latest.id}/submit`,
    );
  }
}

async function ensureLabMapping(dm, studyId) {
  const mappings = await dm.get(`/studies/${studyId}/lab-import/mappings`);
  if (mappings.some((m) => m.name === LAB_MAPPING_NAME)) return;
  log(`creating lab-import mapping "${LAB_MAPPING_NAME}"`);
  await dm.post(`/studies/${studyId}/lab-import/mappings`, {
    name: LAB_MAPPING_NAME,
    config: LAB_MAPPING_CONFIG,
  });
}

// ---------------------------------------------------------------------------
// Capture

async function shoot(page, name, locator) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const file = path.join(outDir, `${name}.png`);
  if (locator) {
    // Element capture: for shots whose full page would duplicate another
    // shot, crop to the panel the docs actually discuss.
    await locator.screenshot({ path: file });
    log(`captured ${path.relative(root, file)}`);
    return;
  }
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
    const invCtx = await login("demo-inv");
    const craCtx = await login("demo-cra");
    if (!dmCtx || !coordCtx || !demoAdminCtx || !invCtx || !craCtx) {
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
    const dynFormId = await ensureDynamicFieldsForm(coord, demoStudy.id);
    const rptFormId = await ensureRptStudy(admin, coord);
    // Coding before the snapshot so the snapshot's codings table has rows.
    await ensureCodingRun(dm, demoStudy.id);
    const snapshotId = await ensureSnapshot(dm, demoStudy.id);
    await runWorkbenchExamples(dm, demoStudy.id, snapshotId);
    await ensureAnomalies(playwright, admin);
    const amdStudyId = await ensureAmendmentStudy(admin, coord);
    const bld = await ensureBlindedStudy(playwright, admin, coord);
    const usdmStudyId = await ensureProtocolStudy(admin);
    await ensureSiteLayouts(coord, demoStudy.id, site1.id);
    await ensureLabMapping(dm, demoStudy.id);

    const matrix = await coord.get(`/studies/${demoStudy.id}/matrix`);
    const demo002 = matrix.subjects.find((s) => s.subjectKey === "DEMO-002");
    const vsFormId = demo002?.cells["SE.SCREENING:FO.VS"]?.formInstanceId;
    if (!vsFormId) throw new Error("DEMO-002 vitals form not found in matrix");
    const demo001 = matrix.subjects.find((s) => s.subjectKey === "DEMO-001");
    const demo001VsFormId = demo001?.cells["SE.SCREENING:FO.VS"]?.formInstanceId;
    if (!demo001VsFormId) throw new Error("DEMO-001 vitals form not found in matrix");
    await ensureManualQuery(dm, demo001VsFormId);
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
        name: "dynamic-fields",
        context: coordCtx,
        async run(page) {
          await page.goto(`/forms/${dynFormId}`);
          await page.getByText("not collected").first().waitFor();
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
      {
        name: "rules-panel",
        context: demoAdminCtx,
        locator: (page) => page.locator('h2:has-text("Conditions & methods")').locator(".."),
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/builds/${buildVersion}`);
          await page.getByText("edit check").first().waitFor();
        },
      },
      {
        name: "rules-syntax-error",
        context: demoAdminCtx,
        locator: (page) => page.locator('h2:has-text("Conditions & methods")').locator(".."),
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/builds/${buildVersion}`);
          await page.getByText("edit check").first().waitFor();
          await page.getByRole("button", { name: "Edit build" }).click();
          // Break the first condition's expression; nothing is persisted
          // without "Save as new build", so this is a pure UI state.
          await page
            .getByPlaceholder("jsonata expression", { exact: false })
            .first()
            .fill("`IT.VS.SYSBP` <<< 70");
          await page.getByText("Expression does not parse").first().waitFor();
        },
      },
      {
        name: "amendments-diff",
        context: demoAdminCtx,
        async run(page) {
          await page.goto(`/studies/${amdStudyId}`);
          await page.getByText("Amendments").first().waitFor();
          await page.getByText("added").first().waitFor();
        },
      },
      {
        name: "amendments-impact",
        context: demoAdminCtx,
        async run(page) {
          await page.goto(`/studies/${amdStudyId}`);
          await page.getByRole("button", { name: "Analyze impact" }).click();
          await page.getByText("will migrate").first().waitFor();
        },
      },
      {
        name: "blinded-entry",
        context: coordCtx,
        async run(page) {
          await page.goto(`/forms/${bld.formId}`);
          // Values render inside inputs (not text nodes); the question text
          // appearing means the form data, arm included, has loaded.
          await page.getByText("Treatment arm assigned by the RTSM").first().waitFor();
        },
      },
      {
        name: "blinded-field",
        context: craCtx,
        async run(page) {
          await page.goto(`/forms/${bld.formId}`);
          await page.getByText("blinded", { exact: true }).first().waitFor();
        },
      },
      {
        name: "break-blind",
        context: invCtx,
        async run(page) {
          await page.goto(`/studies/${bld.studyId}/subjects`);
          await page.getByTitle("Change status of BLD-001").selectOption("unblind");
          // The confirm step (category + reason) is shown but never
          // submitted: the blind stays intact across runs.
          await page.getByPlaceholder("Reason for unblinding").waitFor();
        },
      },
      {
        name: "subject-lifecycle",
        context: coordCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/subjects`);
          await page.getByTitle("Change status of DEMO-003").selectOption("screen_fail");
          // Reason prompt shown, never confirmed — DEMO-003 stays in
          // screening for the subject-matrix shot.
          await page.getByPlaceholder("Reason to screen fail").waitFor();
        },
      },
      {
        name: "notifications-bell",
        context: invCtx,
        async run(page) {
          await page.goto("/studies");
          await page.getByRole("button", { name: /Notifications/ }).click();
          await page.getByText("New query on DEMO-001").first().waitFor();
        },
      },
      {
        name: "sign-form",
        context: invCtx,
        async run(page) {
          await page.goto(`/forms/${demo001VsFormId}`);
          await page.getByRole("button", { name: "Sign…" }).click();
          // Credentials are never entered: the shot shows the Part 11
          // re-authentication step, not a signature.
          await page.getByText("Electronic signature").first().waitFor();
        },
      },
      {
        name: "site-forms-editor",
        context: coordCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/site-forms`);
          await page.getByText("Data-equivalent to the sponsor").first().waitFor();
        },
      },
      {
        name: "approval-queue",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/site-form-approvals`);
          await page.getByRole("button", { name: "Approve" }).first().waitFor();
        },
      },
      {
        name: "protocol-review",
        context: demoAdminCtx,
        async run(page) {
          await page.goto(`/studies/${usdmStudyId}/protocol/1`);
          await page.getByRole("button", { name: /Publish/ }).first().waitFor();
        },
      },
      {
        name: "lab-import",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}`);
          await page.getByText("Lab data import").first().waitFor();
          await page.locator('input[type="file"][accept=".csv"]').setInputFiles({
            name: "central-lab-2026-07.csv",
            mimeType: "text/csv",
            buffer: Buffer.from(LAB_CSV),
          });
          await page.getByRole("button", { name: "Validate" }).click();
          await page.getByText("Nothing has been written yet.").first().waitFor();
        },
      },
      {
        name: "rtsm-panel",
        context: demoAdminCtx,
        async run(page) {
          await page.goto(`/studies/${bld.studyId}`);
          await page.getByText("applied").first().waitFor();
        },
      },
      {
        name: "snapshot-exports",
        context: dmCtx,
        async run(page) {
          await page.goto(`/studies/${demoStudy.id}/workbench`);
          await page.locator("#snapshot-select").waitFor();
          await page.getByText("Dataset-JSON").first().waitFor();
        },
      },
    ];

    for (const shot of shots) {
      if (only && !only.includes(shot.name)) continue;
      const context = shot.context ?? (await newContext());
      const page = await context.newPage();
      try {
        await shot.run(page);
        await shoot(page, shot.name, shot.locator ? shot.locator(page) : undefined);
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
