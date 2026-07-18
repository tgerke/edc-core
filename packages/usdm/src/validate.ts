import type { UsdmScheduleTimeline, UsdmStudyDesign, UsdmWrapper } from "./model.js";
import { SUPPORTED_USDM_VERSION_MAJOR } from "./parse.js";

export interface UsdmValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

/**
 * Semantic validation of a parsed USDM wrapper: cross-reference integrity
 * for everything the compiler consumes, plus structural expectations from
 * USDM-IG §6.3 (one StudyVersion, at least one StudyDesign). Content the
 * model keeps opaque (objectives, eligibility, amendments) is not checked.
 */
export function validateUsdmPackage(wrapper: UsdmWrapper): UsdmValidationIssue[] {
  const issues: UsdmValidationIssue[] = [];

  if (!wrapper.usdmVersion.startsWith(`${SUPPORTED_USDM_VERSION_MAJOR}.`)) {
    issues.push({
      severity: "warning",
      path: "usdmVersion",
      message: `authored for USDM ${wrapper.usdmVersion}; edc-core targets ${SUPPORTED_USDM_VERSION_MAJOR}.x`,
    });
  }

  const versions = wrapper.study.versions;
  if (versions.length === 0) {
    issues.push({ severity: "error", path: "study", message: "no StudyVersion present" });
    return issues;
  }
  if (versions.length > 1) {
    issues.push({
      severity: "warning",
      path: "study",
      message: `${versions.length} StudyVersions present; only the first is used`,
    });
  }
  const version = versions[0];
  if (!version) return issues;

  if (version.studyDesigns.length === 0) {
    issues.push({
      severity: "error",
      path: `StudyVersion[${version.id}]`,
      message: "no StudyDesign present",
    });
  }
  if (version.studyDesigns.length > 1) {
    issues.push({
      severity: "warning",
      path: `StudyVersion[${version.id}]`,
      message: `${version.studyDesigns.length} StudyDesigns present; only the first is used`,
    });
  }

  const bcIds = new Set(version.biomedicalConcepts.map((bc) => bc.id));
  const categoryIds = new Set(version.bcCategories.map((c) => c.id));
  const surrogateIds = new Set(version.bcSurrogates.map((s) => s.id));

  for (const category of version.bcCategories) {
    for (const memberId of category.memberIds) {
      if (!bcIds.has(memberId)) {
        issues.push({
          severity: "error",
          path: `BiomedicalConceptCategory[${category.id}]`,
          message: `memberId → "${memberId}" does not resolve to a BiomedicalConcept`,
        });
      }
    }
  }

  for (const design of version.studyDesigns) {
    validateDesign(issues, design, { bcIds, categoryIds, surrogateIds });
  }

  return issues;
}

function validateDesign(
  issues: UsdmValidationIssue[],
  design: UsdmStudyDesign,
  pools: { bcIds: Set<string>; categoryIds: Set<string>; surrogateIds: Set<string> },
): void {
  const at = `StudyDesign[${design.id}]`;

  const encounterIds = new Set(design.encounters.map((e) => e.id));
  const activityIds = new Set(design.activities.map((a) => a.id));
  const epochIds = new Set(design.epochs.map((e) => e.id));
  const timelineIds = new Set(design.scheduleTimelines.map((t) => t.id));
  const timingIds = new Set(design.scheduleTimelines.flatMap((t) => t.timings.map((x) => x.id)));

  checkDuplicates(issues, `${at}.encounters`, [...design.encounters.map((e) => e.id)]);
  checkDuplicates(issues, `${at}.activities`, [...design.activities.map((a) => a.id)]);

  const mains = design.scheduleTimelines.filter((t) => t.mainTimeline);
  if (mains.length === 0) {
    issues.push({ severity: "error", path: at, message: "no main ScheduleTimeline" });
  }
  if (mains.length > 1) {
    issues.push({
      severity: "warning",
      path: at,
      message: `${mains.length} main ScheduleTimelines; only the first is used`,
    });
  }

  for (const activity of design.activities) {
    const from = `Activity[${activity.id}]`;
    for (const childId of activity.childIds) {
      if (!activityIds.has(childId)) {
        issues.push({
          severity: "error",
          path: from,
          message: `childId → "${childId}" does not resolve to an Activity`,
        });
      }
    }
    for (const bcId of activity.biomedicalConceptIds) {
      if (!pools.bcIds.has(bcId)) {
        issues.push({
          severity: "error",
          path: from,
          message: `biomedicalConceptId → "${bcId}" does not resolve to a BiomedicalConcept`,
        });
      }
    }
    for (const categoryId of activity.bcCategoryIds) {
      if (!pools.categoryIds.has(categoryId)) {
        issues.push({
          severity: "error",
          path: from,
          message: `bcCategoryId → "${categoryId}" does not resolve to a BiomedicalConceptCategory`,
        });
      }
    }
    for (const surrogateId of activity.bcSurrogateIds) {
      if (!pools.surrogateIds.has(surrogateId)) {
        issues.push({
          severity: "error",
          path: from,
          message: `bcSurrogateId → "${surrogateId}" does not resolve to a BiomedicalConceptSurrogate`,
        });
      }
    }
    if (activity.timelineId && !timelineIds.has(activity.timelineId)) {
      issues.push({
        severity: "error",
        path: from,
        message: `timelineId → "${activity.timelineId}" does not resolve to a ScheduleTimeline`,
      });
    }
  }

  for (const encounter of design.encounters) {
    if (encounter.scheduledAtId && !timingIds.has(encounter.scheduledAtId)) {
      issues.push({
        severity: "error",
        path: `Encounter[${encounter.id}]`,
        message: `scheduledAtId → "${encounter.scheduledAtId}" does not resolve to a Timing`,
      });
    }
  }

  const scheduledActivityIds = new Set<string>();
  const scheduledEncounterIds = new Set<string>();
  for (const timeline of design.scheduleTimelines) {
    validateTimeline(issues, timeline, { encounterIds, activityIds, epochIds });
    for (const instance of timeline.instances) {
      if (instance.instanceType !== "ScheduledActivityInstance") continue;
      for (const id of instance.activityIds) scheduledActivityIds.add(id);
      if (instance.encounterId) scheduledEncounterIds.add(instance.encounterId);
    }
  }

  // Grouping activities (those with children) are presentation-only and are
  // not expected to be scheduled themselves (USDM-IG §4.11).
  const childActivityIds = new Set(design.activities.flatMap((a) => a.childIds));
  for (const activity of design.activities) {
    if (activity.childIds.length > 0) continue;
    if (!scheduledActivityIds.has(activity.id) && !childActivityIds.has(activity.id)) {
      issues.push({
        severity: "warning",
        path: `Activity[${activity.id}]`,
        message: "defined but never scheduled",
      });
    }
  }
  for (const encounter of design.encounters) {
    if (!scheduledEncounterIds.has(encounter.id)) {
      issues.push({
        severity: "warning",
        path: `Encounter[${encounter.id}]`,
        message: "defined but never scheduled",
      });
    }
  }
}

function validateTimeline(
  issues: UsdmValidationIssue[],
  timeline: UsdmScheduleTimeline,
  pools: { encounterIds: Set<string>; activityIds: Set<string>; epochIds: Set<string> },
): void {
  const at = `ScheduleTimeline[${timeline.id}]`;
  const instanceIds = new Set(timeline.instances.map((i) => i.id));
  const exitIds = new Set(timeline.exits.map((e) => e.id));

  checkDuplicates(issues, `${at}.instances`, [...timeline.instances.map((i) => i.id)]);

  if (!instanceIds.has(timeline.entryId)) {
    issues.push({
      severity: "error",
      path: at,
      message: `entryId → "${timeline.entryId}" does not resolve to a ScheduledInstance`,
    });
  }

  for (const instance of timeline.instances) {
    const from = `${at}.ScheduledInstance[${instance.id}]`;
    if (instance.defaultConditionId && !instanceIds.has(instance.defaultConditionId)) {
      issues.push({
        severity: "error",
        path: from,
        message: `defaultConditionId → "${instance.defaultConditionId}" does not resolve to a ScheduledInstance`,
      });
    }
    if (instance.epochId && !pools.epochIds.has(instance.epochId)) {
      issues.push({
        severity: "error",
        path: from,
        message: `epochId → "${instance.epochId}" does not resolve to a StudyEpoch`,
      });
    }
    if (instance.instanceType === "ScheduledActivityInstance") {
      if (instance.timelineExitId && !exitIds.has(instance.timelineExitId)) {
        issues.push({
          severity: "error",
          path: from,
          message: `timelineExitId → "${instance.timelineExitId}" does not resolve to a ScheduleTimelineExit`,
        });
      }
      if (instance.encounterId && !pools.encounterIds.has(instance.encounterId)) {
        issues.push({
          severity: "error",
          path: from,
          message: `encounterId → "${instance.encounterId}" does not resolve to an Encounter`,
        });
      }
      for (const activityId of instance.activityIds) {
        if (!pools.activityIds.has(activityId)) {
          issues.push({
            severity: "error",
            path: from,
            message: `activityId → "${activityId}" does not resolve to an Activity`,
          });
        }
      }
    } else {
      for (const assignment of instance.conditionAssignments) {
        if (!instanceIds.has(assignment.conditionTargetId)) {
          issues.push({
            severity: "error",
            path: from,
            message: `conditionTargetId → "${assignment.conditionTargetId}" does not resolve to a ScheduledInstance`,
          });
        }
      }
    }
  }

  for (const timing of timeline.timings) {
    const from = `${at}.Timing[${timing.id}]`;
    if (!instanceIds.has(timing.relativeFromScheduledInstanceId)) {
      issues.push({
        severity: "error",
        path: from,
        message: `relativeFromScheduledInstanceId → "${timing.relativeFromScheduledInstanceId}" does not resolve to a ScheduledInstance`,
      });
    }
    if (
      timing.relativeToScheduledInstanceId &&
      !instanceIds.has(timing.relativeToScheduledInstanceId)
    ) {
      issues.push({
        severity: "error",
        path: from,
        message: `relativeToScheduledInstanceId → "${timing.relativeToScheduledInstanceId}" does not resolve to a ScheduledInstance`,
      });
    }
  }
}

function checkDuplicates(issues: UsdmValidationIssue[], kind: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      issues.push({ severity: "error", path: `${kind}[${id}]`, message: "duplicate id" });
    }
    seen.add(id);
  }
}
