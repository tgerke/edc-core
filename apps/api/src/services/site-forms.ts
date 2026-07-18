import {
  type SiteFormVariantDefinition,
  siteFormVariantDefinitionSchema,
  type ValidationIssue,
  validateVariantCoverage,
  variantFormsForEvent,
} from "@edc-core/odm";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  siteFormVariants,
  siteFormVariantVersions,
  studyMetadataVersions,
} from "../db/schema/index.js";
import { notifyPermissionHolders } from "./notifications.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/**
 * Site form variants: sponsor-governed data, site-adaptable presentation.
 * The lifecycle is draft → submitted → approved | changes_requested, with
 * retired and stale as terminal/parked states. Data-equivalence is enforced
 * structurally by validateVariantCoverage; sponsor approval is a workflow
 * review, not a data review. Every transition writes an audit event.
 */

export class SiteFormError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

async function buildDefinition(db: Db, metadataVersionId: string) {
  const [row] = await db
    .select({ definition: studyMetadataVersions.definition })
    .from(studyMetadataVersions)
    .where(eq(studyMetadataVersions.id, metadataVersionId))
    .limit(1);
  if (!row) throw new SiteFormError("not_found", "build not found");
  return (row.definition as unknown as StudyBuildDefinition).metaDataVersion;
}

export interface VariantValidationResult {
  issues: ValidationIssue[];
}

export async function validateVariantAgainstBuild(
  db: Db,
  metadataVersionId: string,
  definition: SiteFormVariantDefinition,
): Promise<ValidationIssue[]> {
  const mdv = await buildDefinition(db, metadataVersionId);
  return validateVariantCoverage(mdv, definition);
}

export async function createVariant(
  db: Db,
  input: {
    studyId: string;
    siteId: string;
    name: string;
    metadataVersionId: string;
    definition: unknown;
    actorId: string;
  },
) {
  const parsed = siteFormVariantDefinitionSchema.safeParse(input.definition);
  if (!parsed.success) throw new SiteFormError("invalid", parsed.error.message);
  const issues = await validateVariantAgainstBuild(db, input.metadataVersionId, parsed.data);

  return db.transaction(async (tx) => {
    const [variant] = await tx
      .insert(siteFormVariants)
      .values({
        studyId: input.studyId,
        siteId: input.siteId,
        name: input.name,
        createdBy: input.actorId,
      })
      .returning();
    if (!variant) throw new Error("variant insert returned no row");

    const [version] = await tx
      .insert(siteFormVariantVersions)
      .values({
        variantId: variant.id,
        version: 1,
        metadataVersionId: input.metadataVersionId,
        definition: parsed.data,
        createdBy: input.actorId,
      })
      .returning();
    if (!version) throw new Error("variant version insert returned no row");

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "site_forms.variant_created",
      entityType: "site_form_variant",
      entityId: variant.id,
      newValue: { siteId: input.siteId, name: input.name, version: 1 },
    });

    return { variant, version, issues };
  });
}

/** Each save appends a new draft version; prior rows stay for audit. */
export async function saveVariantVersion(
  db: Db,
  input: {
    studyId: string;
    variantId: string;
    metadataVersionId: string;
    definition: unknown;
    actorId: string;
  },
) {
  const parsed = siteFormVariantDefinitionSchema.safeParse(input.definition);
  if (!parsed.success) throw new SiteFormError("invalid", parsed.error.message);
  const issues = await validateVariantAgainstBuild(db, input.metadataVersionId, parsed.data);

  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ version: siteFormVariantVersions.version })
      .from(siteFormVariantVersions)
      .where(eq(siteFormVariantVersions.variantId, input.variantId))
      .orderBy(desc(siteFormVariantVersions.version))
      .limit(1);
    if (!latest) throw new SiteFormError("not_found", "variant not found");

    const [version] = await tx
      .insert(siteFormVariantVersions)
      .values({
        variantId: input.variantId,
        version: latest.version + 1,
        metadataVersionId: input.metadataVersionId,
        definition: parsed.data,
        createdBy: input.actorId,
      })
      .returning();
    if (!version) throw new Error("variant version insert returned no row");

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "site_forms.version_saved",
      entityType: "site_form_variant_version",
      entityId: version.id,
      newValue: { variantId: input.variantId, version: version.version },
    });

    return { version, issues };
  });
}

type TransitionAction = "submit" | "approve" | "request_changes" | "retire";

const TRANSITIONS: Record<
  TransitionAction,
  { from: readonly string[]; to: "submitted" | "approved" | "changes_requested" | "retired" }
> = {
  submit: { from: ["draft", "changes_requested"], to: "submitted" },
  approve: { from: ["submitted"], to: "approved" },
  request_changes: { from: ["submitted"], to: "changes_requested" },
  retire: { from: ["approved", "stale"], to: "retired" },
};

export async function transitionVariantVersion(
  db: Db,
  input: {
    studyId: string;
    versionId: string;
    action: TransitionAction;
    note?: string;
    actorId: string;
  },
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(siteFormVariantVersions)
      .where(eq(siteFormVariantVersions.id, input.versionId))
      .limit(1);
    if (!row) throw new SiteFormError("not_found", "variant version not found");

    const transition = TRANSITIONS[input.action];
    if (!transition.from.includes(row.status)) {
      throw new SiteFormError("conflict", `cannot ${input.action} a ${row.status} variant version`);
    }

    if (input.action === "submit") {
      const definition = siteFormVariantDefinitionSchema.parse(row.definition);
      const issues = await validateVariantAgainstBuild(db, row.metadataVersionId, definition);
      if (issues.some((i) => i.severity === "error")) {
        throw new SiteFormError(
          "conflict",
          "variant fails data-equivalence validation against its build; fix the errors before submitting",
        );
      }
      // One approved layout per site/build: approving this one later would
      // be ambiguous if several sit in the queue for the same scope.
    }

    const now = new Date();
    const [updated] = await tx
      .update(siteFormVariantVersions)
      .set({
        status: transition.to,
        ...(input.action === "submit" ? { submittedAt: now } : {}),
        ...(input.action === "approve" || input.action === "request_changes"
          ? { decidedBy: input.actorId, decidedAt: now, decisionNote: input.note ?? null }
          : {}),
      })
      .where(eq(siteFormVariantVersions.id, input.versionId))
      .returning();
    if (!updated) throw new Error("variant version update returned no row");

    // A newly approved version supersedes any older approved version of the
    // same variant (they would otherwise both match capture lookups).
    if (input.action === "approve") {
      await tx
        .update(siteFormVariantVersions)
        .set({ status: "retired" })
        .where(
          and(
            eq(siteFormVariantVersions.variantId, updated.variantId),
            eq(siteFormVariantVersions.status, "approved"),
            ne(siteFormVariantVersions.id, updated.id),
          ),
        );
    }

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: `site_forms.${input.action}`,
      entityType: "site_form_variant_version",
      entityId: updated.id,
      newValue: {
        variantId: updated.variantId,
        version: updated.version,
        status: updated.status,
        note: input.note ?? null,
      },
    });

    return updated;
  });
}

/**
 * The approved variant version a site captures through on a given build,
 * if any. Latest approval wins.
 */
export async function effectiveVariantVersion(
  db: Db,
  input: { studyId: string; siteId: string; metadataVersionId: string },
) {
  const [row] = await db
    .select({
      id: siteFormVariantVersions.id,
      variantId: siteFormVariantVersions.variantId,
      version: siteFormVariantVersions.version,
      definition: siteFormVariantVersions.definition,
    })
    .from(siteFormVariantVersions)
    .innerJoin(siteFormVariants, eq(siteFormVariantVersions.variantId, siteFormVariants.id))
    .where(
      and(
        eq(siteFormVariants.studyId, input.studyId),
        eq(siteFormVariants.siteId, input.siteId),
        eq(siteFormVariantVersions.metadataVersionId, input.metadataVersionId),
        eq(siteFormVariantVersions.status, "approved"),
      ),
    )
    .orderBy(desc(siteFormVariantVersions.decidedAt))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    definition: siteFormVariantDefinitionSchema.parse(row.definition),
  };
}

/**
 * What capture should render for a site at an event: the approved variant's
 * forms when one covers the event, else the build's standard forms.
 */
export async function effectiveFormsForEvent(
  db: Db,
  input: { studyId: string; siteId: string; metadataVersionId: string; eventOid: string },
): Promise<
  | { source: "variant"; variantVersionId: string; forms: { oid: string; name: string }[] }
  | { source: "standard" }
> {
  const effective = await effectiveVariantVersion(db, input);
  if (!effective) return { source: "standard" };
  const forms = variantFormsForEvent(effective.definition, input.eventOid);
  if (forms.length === 0) return { source: "standard" };
  return {
    source: "variant",
    variantVersionId: effective.id,
    forms: forms.map((f) => ({ oid: f.oid, name: f.name })),
  };
}

/**
 * Amendment integration: when a new build publishes, every approved variant
 * is revalidated against it. Data-equivalent variants are carried forward
 * automatically (a cloned approved version targeting the new build, audited
 * as a system action); the rest are marked stale — capture falls back to the
 * standard forms until the site submits an updated layout — and both the
 * site and the sponsor are notified. Runs inside the build-publish
 * transaction so the outcome commits atomically with the amendment; variant
 * problems never block the amendment itself.
 */
export async function revalidateVariantsForBuild(
  db: Db,
  input: { studyId: string; newMetadataVersionId: string; actorId: string },
): Promise<{ carried: number; staled: number }> {
  const newMdv = await buildDefinition(db, input.newMetadataVersionId);

  const approvedRows = await db
    .select({
      versionId: siteFormVariantVersions.id,
      variantId: siteFormVariantVersions.variantId,
      version: siteFormVariantVersions.version,
      metadataVersionId: siteFormVariantVersions.metadataVersionId,
      definition: siteFormVariantVersions.definition,
      siteId: siteFormVariants.siteId,
      name: siteFormVariants.name,
    })
    .from(siteFormVariantVersions)
    .innerJoin(siteFormVariants, eq(siteFormVariantVersions.variantId, siteFormVariants.id))
    .where(
      and(
        eq(siteFormVariants.studyId, input.studyId),
        eq(siteFormVariantVersions.status, "approved"),
      ),
    );

  let carried = 0;
  let staled = 0;
  for (const row of approvedRows) {
    if (row.metadataVersionId === input.newMetadataVersionId) continue;
    const definition = siteFormVariantDefinitionSchema.parse(row.definition);
    const issues = validateVariantCoverage(newMdv, definition).filter(
      (i) => i.severity === "error",
    );

    if (issues.length === 0) {
      const [latest] = await db
        .select({ version: siteFormVariantVersions.version })
        .from(siteFormVariantVersions)
        .where(eq(siteFormVariantVersions.variantId, row.variantId))
        .orderBy(desc(siteFormVariantVersions.version))
        .limit(1);
      const [carriedRow] = await db
        .insert(siteFormVariantVersions)
        .values({
          variantId: row.variantId,
          version: (latest?.version ?? row.version) + 1,
          metadataVersionId: input.newMetadataVersionId,
          definition: row.definition as object,
          status: "approved",
          decidedBy: input.actorId,
          decidedAt: new Date(),
          decisionNote: "carried forward on amendment (still data-equivalent)",
          createdBy: input.actorId,
        })
        .returning();
      // The superseded approval is retired so only one approval is live.
      await db
        .update(siteFormVariantVersions)
        .set({ status: "retired" })
        .where(eq(siteFormVariantVersions.id, row.versionId));
      await db.insert(auditEvents).values({
        actorId: input.actorId,
        studyId: input.studyId,
        action: "site_forms.carried_forward",
        entityType: "site_form_variant_version",
        entityId: carriedRow?.id ?? row.versionId,
        newValue: { variantId: row.variantId, metadataVersionId: input.newMetadataVersionId },
      });
      carried++;
      continue;
    }

    await db
      .update(siteFormVariantVersions)
      .set({ status: "stale" })
      .where(eq(siteFormVariantVersions.id, row.versionId));
    await db.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "site_forms.staled",
      entityType: "site_form_variant_version",
      entityId: row.versionId,
      newValue: {
        variantId: row.variantId,
        metadataVersionId: input.newMetadataVersionId,
        issues: issues.map((i) => i.message).slice(0, 5),
      },
    });
    const notification = {
      studyId: input.studyId,
      type: "site_forms.stale" as const,
      title: `Site layout "${row.name}" needs an update`,
      body: "A new study build changed the data this layout covers. Capture uses the standard forms until an updated layout is approved.",
      payload: { variantId: row.variantId, siteId: row.siteId },
      dedupeKey: `site_forms.stale:${row.versionId}`,
    };
    await notifyPermissionHolders(db, {
      permission: "site.forms.manage",
      scope: { studyId: input.studyId, siteId: row.siteId },
      excludeUserId: input.actorId,
      notification,
    });
    await notifyPermissionHolders(db, {
      permission: "study.manage",
      scope: { studyId: input.studyId },
      excludeUserId: input.actorId,
      notification,
    });
    staled++;
  }

  return { carried, staled };
}
