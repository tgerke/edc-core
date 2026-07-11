// Seeds a complete demo environment around examples/demo-study.xml (SC-03):
// study + sites, one user per clinical role, an imported build, enrolled
// subjects with entered vitals — including one out-of-range value so a
// system query is open on first login — plus the synthetic sample coding
// dictionaries, bound to the study, with AE/CM verbatims so the coding page
// shows every status. Idempotent: exits if the demo study already exists.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { dictionaries, roles, sites, studies, users } from "../db/schema/index.js";
import {
  enrollSubject,
  ensureFormInstance,
  resolveFormContext,
  transitionForm,
  writeItemValue,
} from "../services/capture.js";
import { evaluateFormChecks } from "../services/checks.js";
import { setDictionaryBinding } from "../services/coding.js";
import { type DictionaryType, loadDictionary } from "../services/dictionaries.js";
import { importStudyBuild } from "../services/study-builds.js";

const STUDY_OID = "ST.CDASH.DEMO";
const PASSWORD = process.env.EDC_DEMO_PASSWORD ?? "demo-Passw0rd-2026";

const odmPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/demo-study.xml",
);

await runMigrations();
const { db, client } = createDb();

try {
  const [existing] = await db.select().from(studies).where(eq(studies.oid, STUDY_OID));
  if (existing) {
    console.log(`demo study ${STUDY_OID} already exists; nothing to do`);
    process.exit(0);
  }

  const [study] = await db
    .insert(studies)
    .values({
      oid: STUDY_OID,
      name: "edc-core Demo Study",
      protocolName: "EDC-DEMO-001",
      status: "active",
    })
    .returning();
  if (!study) throw new Error("study insert failed");
  const [site1] = await db
    .insert(sites)
    .values({ studyId: study.id, oid: "SITE.001", name: "Tampa General Hospital" })
    .returning();
  const [site2] = await db
    .insert(sites)
    .values({ studyId: study.id, oid: "SITE.002", name: "Moffitt Cancer Center" })
    .returning();
  if (!site1 || !site2) throw new Error("site insert failed");

  const DEMO_USERS = [
    { username: "demo-admin", fullName: "Demo Administrator", role: "admin" },
    { username: "demo-dm", fullName: "Demo Data Manager", role: "data_manager" },
    { username: "demo-inv", fullName: "Demo Investigator", role: "investigator", siteId: site1.id },
    { username: "demo-coord", fullName: "Demo Coordinator", role: "data_entry", siteId: site1.id },
    { username: "demo-cra", fullName: "Demo Monitor", role: "monitor" },
  ] as const;

  const userIds: Record<string, string> = {};
  for (const spec of DEMO_USERS) {
    let [user] = await db.select().from(users).where(eq(users.username, spec.username));
    if (!user) {
      [user] = await db
        .insert(users)
        .values({
          username: spec.username,
          email: `${spec.username}@example.invalid`,
          fullName: spec.fullName,
          passwordHash: await hashPassword(PASSWORD),
        })
        .returning();
    }
    if (!user) throw new Error(`user ${spec.username} failed`);
    userIds[spec.username] = user.id;
    const [role] = await db.select().from(roles).where(eq(roles.name, spec.role));
    if (!role) throw new Error(`seeded role ${spec.role} missing — run migrations`);
    await grantRole(db, {
      userId: user.id,
      studyId: study.id,
      roleId: role.id,
      ...("siteId" in spec ? { siteId: spec.siteId } : {}),
      grantedBy: user.id,
    });
  }
  const admin = userIds["demo-admin"] as string;
  const coordinator = userIds["demo-coord"] as string;

  const imported = await importStudyBuild(db, {
    studyId: study.id,
    content: readFileSync(odmPath, "utf8"),
    actorId: admin,
  });
  if (!imported.ok) {
    throw new Error(`demo ODM failed validation: ${JSON.stringify(imported.issues, null, 2)}`);
  }

  // Subject 1: clean vitals, form completed.
  const subject1 = await enrollSubject(db, {
    studyId: study.id,
    siteId: site1.id,
    subjectKey: "DEMO-001",
    actorId: coordinator,
  });
  const form1 = await ensureFormInstance(db, {
    subjectId: subject1.id,
    eventOid: "SE.SCREENING",
    formOid: "FO.VS",
    actorId: coordinator,
  });
  const enter = async (
    formInstanceId: string,
    values: Record<string, string>,
    itemGroupOid = "IG.VS",
  ) => {
    for (const [itemOid, value] of Object.entries(values)) {
      const context = await resolveFormContext(db, formInstanceId);
      if (!context) throw new Error("form context missing");
      await writeItemValue(db, context, {
        itemGroupOid,
        itemOid,
        value,
        actorId: coordinator,
      });
      await evaluateFormChecks(db, context, coordinator);
    }
  };
  await enter(form1.id, {
    "IT.VS.VSDTC": "2026-07-01",
    "IT.VS.SYSBP": "126",
    "IT.VS.DIABP": "78",
    "IT.VS.PULSE": "68",
    "IT.VS.TEMP": "36.7",
    "IT.VS.HEIGHT": "172.5",
    "IT.VS.WEIGHT": "70.2",
  });
  const context1 = await resolveFormContext(db, form1.id);
  if (context1) await transitionForm(db, context1, "complete", coordinator);

  // Subject 2: implausible systolic BP → the range check opens a system query.
  const subject2 = await enrollSubject(db, {
    studyId: study.id,
    siteId: site1.id,
    subjectKey: "DEMO-002",
    actorId: coordinator,
  });
  const form2 = await ensureFormInstance(db, {
    subjectId: subject2.id,
    eventOid: "SE.SCREENING",
    formOid: "FO.VS",
    actorId: coordinator,
  });
  await enter(form2.id, {
    "IT.VS.VSDTC": "2026-07-02",
    "IT.VS.SYSBP": "62",
    "IT.VS.DIABP": "41",
    "IT.VS.PULSE": "88",
  });

  // Coding: load the synthetic sample dictionaries (global — skip any that
  // survive from an earlier seed), bind them to the study, and enter AE/CM
  // verbatims so the coding page shows both an auto-codable term and one
  // that needs a human ("stomach ake").
  const examplesDir = path.dirname(odmPath);
  for (const [type, file] of [
    ["MedDRA", "meddra-sample.csv"],
    ["WHODrug", "whodrug-sample.csv"],
  ] as [DictionaryType, string][]) {
    const [dictionary] = await db
      .select()
      .from(dictionaries)
      .where(and(eq(dictionaries.type, type), eq(dictionaries.version, "sample-1.0")));
    const dictionaryId =
      dictionary?.id ??
      (
        await loadDictionary(db, {
          type,
          version: "sample-1.0",
          content: readFileSync(path.join(examplesDir, "dictionaries", file), "utf8"),
          actorId: admin,
        })
      ).id;
    await setDictionaryBinding(db, {
      studyId: study.id,
      dictionaryType: type,
      dictionaryId,
      actorId: admin,
    });
  }

  const ae1 = await ensureFormInstance(db, {
    subjectId: subject1.id,
    eventOid: "SE.AE",
    formOid: "FO.AE",
    actorId: coordinator,
  });
  await enter(
    ae1.id,
    {
      "IT.AE.AETERM": "Headache",
      "IT.AE.AESTDTC": "2026-07-03",
      "IT.AE.AESEV": "1",
      "IT.AE.AESER": "false",
      "IT.AE.AEREL": "2",
    },
    "IG.AE",
  );
  const ae2 = await ensureFormInstance(db, {
    subjectId: subject2.id,
    eventOid: "SE.AE",
    formOid: "FO.AE",
    actorId: coordinator,
  });
  await enter(
    ae2.id,
    {
      "IT.AE.AETERM": "stomach ake",
      "IT.AE.AESTDTC": "2026-07-04",
      "IT.AE.AESEV": "2",
      "IT.AE.AESER": "false",
      "IT.AE.AEREL": "1",
    },
    "IG.AE",
  );
  const cm1 = await ensureFormInstance(db, {
    subjectId: subject1.id,
    eventOid: "SE.CM",
    formOid: "FO.CM",
    actorId: coordinator,
  });
  await enter(cm1.id, { "IT.CM.CMTRT": "Aspirin", "IT.CM.CMSTDTC": "2026-06-01" }, "IG.CM");

  console.log(`\n✅ demo study seeded: ${STUDY_OID} (${study.id})`);
  console.log(`   subjects: DEMO-001 (complete vitals), DEMO-002 (open system query)`);
  console.log(
    "   coding: sample dictionaries bound; AEs Headache / stomach ake and CM Aspirin await coding",
  );
  console.log(`   users (password: ${PASSWORD}):`);
  for (const spec of DEMO_USERS) {
    console.log(
      `     ${spec.username.padEnd(12)} ${spec.role}${"siteId" in spec ? " @ SITE.001" : ""}`,
    );
  }
  console.log("   set EDC_DEMO_PASSWORD to override the default password.");
} finally {
  await client.end();
}
