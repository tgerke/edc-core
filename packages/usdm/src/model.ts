import { z } from "zod";

/**
 * Typed model of the CDISC USDM v4 API subset edc-core ingests. Field names
 * mirror the USDM API (OpenAPI) property names exactly, including the
 * `*Id`/`*Ids` cross-reference convention of the JSON serialization.
 *
 * Parsing is read-only: the raw wrapper JSON is the stored protocol artifact,
 * so unknown keys are ignored here rather than round-tripped (unlike the ODM
 * model, which is edc-core's native build format).
 *
 * v4 structural notes this model relies on:
 * - biomedicalConcepts / bcCategories / bcSurrogates live on StudyVersion;
 *   activities reference them by id
 * - StudyDesign is a union of InterventionalStudyDesign and
 *   ObservationalStudyDesign, discriminated by instanceType
 * - the API serialization requires `id` and `instanceType` on every class
 */

const idRef = z.string().min(1);

export const codeSchema = z.object({
  id: idRef,
  code: z.string(),
  codeSystem: z.string(),
  codeSystemVersion: z.string(),
  decode: z.string(),
  instanceType: z.string(),
});
export type UsdmCode = z.infer<typeof codeSchema>;

export const aliasCodeSchema = z.object({
  id: idRef,
  standardCode: codeSchema,
  instanceType: z.string(),
});
export type UsdmAliasCode = z.infer<typeof aliasCodeSchema>;

export const timingSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  type: codeSchema,
  value: z.string(),
  valueLabel: z.string(),
  relativeToFrom: codeSchema,
  relativeFromScheduledInstanceId: idRef,
  relativeToScheduledInstanceId: z.string().nullish(),
  windowLower: z.string().nullish(),
  windowUpper: z.string().nullish(),
  windowLabel: z.string().nullish(),
  instanceType: z.string(),
});
export type UsdmTiming = z.infer<typeof timingSchema>;

export const scheduleTimelineExitSchema = z.object({
  id: idRef,
  instanceType: z.string(),
});
export type UsdmScheduleTimelineExit = z.infer<typeof scheduleTimelineExitSchema>;

export const scheduledActivityInstanceSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  defaultConditionId: z.string().nullish(),
  epochId: z.string().nullish(),
  timelineId: z.string().nullish(),
  timelineExitId: z.string().nullish(),
  activityIds: z.array(idRef).default([]),
  encounterId: z.string().nullish(),
  instanceType: z.literal("ScheduledActivityInstance"),
});
export type UsdmScheduledActivityInstance = z.infer<typeof scheduledActivityInstanceSchema>;

export const conditionAssignmentSchema = z.object({
  id: idRef,
  condition: z.string(),
  conditionTargetId: idRef,
  instanceType: z.string(),
});
export type UsdmConditionAssignment = z.infer<typeof conditionAssignmentSchema>;

export const scheduledDecisionInstanceSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  defaultConditionId: z.string().nullish(),
  epochId: z.string().nullish(),
  conditionAssignments: z.array(conditionAssignmentSchema).default([]),
  instanceType: z.literal("ScheduledDecisionInstance"),
});
export type UsdmScheduledDecisionInstance = z.infer<typeof scheduledDecisionInstanceSchema>;

export const scheduledInstanceSchema = z.discriminatedUnion("instanceType", [
  scheduledActivityInstanceSchema,
  scheduledDecisionInstanceSchema,
]);
export type UsdmScheduledInstance = z.infer<typeof scheduledInstanceSchema>;

export const scheduleTimelineSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  mainTimeline: z.boolean(),
  entryCondition: z.string(),
  entryId: idRef,
  exits: z.array(scheduleTimelineExitSchema).default([]),
  timings: z.array(timingSchema).default([]),
  instances: z.array(scheduledInstanceSchema).default([]),
  instanceType: z.string(),
});
export type UsdmScheduleTimeline = z.infer<typeof scheduleTimelineSchema>;

export const encounterSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  type: codeSchema.nullish(),
  previousId: z.string().nullish(),
  nextId: z.string().nullish(),
  scheduledAtId: z.string().nullish(),
  instanceType: z.string(),
});
export type UsdmEncounter = z.infer<typeof encounterSchema>;

export const activitySchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  previousId: z.string().nullish(),
  nextId: z.string().nullish(),
  childIds: z.array(idRef).default([]),
  biomedicalConceptIds: z.array(idRef).default([]),
  bcCategoryIds: z.array(idRef).default([]),
  bcSurrogateIds: z.array(idRef).default([]),
  timelineId: z.string().nullish(),
  instanceType: z.string(),
});
export type UsdmActivity = z.infer<typeof activitySchema>;

export const responseCodeSchema = z.object({
  id: idRef,
  name: z.string(),
  isEnabled: z.boolean(),
  code: codeSchema,
  instanceType: z.string(),
});
export type UsdmResponseCode = z.infer<typeof responseCodeSchema>;

export const biomedicalConceptPropertySchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  isRequired: z.boolean(),
  isEnabled: z.boolean(),
  datatype: z.string(),
  responseCodes: z.array(responseCodeSchema).default([]),
  code: aliasCodeSchema,
  instanceType: z.string(),
});
export type UsdmBiomedicalConceptProperty = z.infer<typeof biomedicalConceptPropertySchema>;

export const biomedicalConceptSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  synonyms: z.array(z.string()).default([]),
  reference: z.string().nullish(),
  properties: z.array(biomedicalConceptPropertySchema).default([]),
  code: aliasCodeSchema,
  instanceType: z.string(),
});
export type UsdmBiomedicalConcept = z.infer<typeof biomedicalConceptSchema>;

export const biomedicalConceptCategorySchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  childIds: z.array(idRef).default([]),
  memberIds: z.array(idRef).default([]),
  code: aliasCodeSchema.nullish(),
  instanceType: z.string(),
});
export type UsdmBiomedicalConceptCategory = z.infer<typeof biomedicalConceptCategorySchema>;

export const biomedicalConceptSurrogateSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  reference: z.string().nullish(),
  instanceType: z.string(),
});
export type UsdmBiomedicalConceptSurrogate = z.infer<typeof biomedicalConceptSurrogateSchema>;

export const studyEpochSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  type: codeSchema.nullish(),
  previousId: z.string().nullish(),
  nextId: z.string().nullish(),
  instanceType: z.string(),
});
export type UsdmStudyEpoch = z.infer<typeof studyEpochSchema>;

/** Arms are display-only for edc-core; the compiler does not consume them. */
export const studyArmSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  type: codeSchema.nullish(),
  instanceType: z.string(),
});
export type UsdmStudyArm = z.infer<typeof studyArmSchema>;

export const studyDesignSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  studyType: codeSchema.nullish(),
  studyPhase: aliasCodeSchema.nullish(),
  epochs: z.array(studyEpochSchema).default([]),
  arms: z.array(studyArmSchema).default([]),
  encounters: z.array(encounterSchema).default([]),
  activities: z.array(activitySchema).default([]),
  scheduleTimelines: z.array(scheduleTimelineSchema).default([]),
  // Read-only protocol viewer content; never compiled into a build.
  objectives: z.array(z.unknown()).default([]),
  eligibilityCriteria: z.array(z.unknown()).default([]),
  estimands: z.array(z.unknown()).default([]),
  instanceType: z.string(),
});
export type UsdmStudyDesign = z.infer<typeof studyDesignSchema>;

export const studyIdentifierSchema = z.object({
  id: idRef,
  text: z.string(),
  scopeId: z.string().nullish(),
  instanceType: z.string(),
});
export type UsdmStudyIdentifier = z.infer<typeof studyIdentifierSchema>;

export const studyTitleSchema = z.object({
  id: idRef,
  text: z.string(),
  type: codeSchema,
  instanceType: z.string(),
});
export type UsdmStudyTitle = z.infer<typeof studyTitleSchema>;

export const organizationSchema = z.object({
  id: idRef,
  name: z.string(),
  label: z.string().nullish(),
  type: codeSchema.nullish(),
  identifierScheme: z.string().nullish(),
  identifier: z.string().nullish(),
  instanceType: z.string(),
});
export type UsdmOrganization = z.infer<typeof organizationSchema>;

export const studyVersionSchema = z.object({
  id: idRef,
  versionIdentifier: z.string(),
  rationale: z.string().nullish(),
  titles: z.array(studyTitleSchema).default([]),
  studyIdentifiers: z.array(studyIdentifierSchema).default([]),
  organizations: z.array(organizationSchema).default([]),
  studyDesigns: z.array(studyDesignSchema).default([]),
  biomedicalConcepts: z.array(biomedicalConceptSchema).default([]),
  bcCategories: z.array(biomedicalConceptCategorySchema).default([]),
  bcSurrogates: z.array(biomedicalConceptSurrogateSchema).default([]),
  // Read-only protocol viewer content; never compiled into a build.
  amendments: z.array(z.unknown()).default([]),
  instanceType: z.string(),
});
export type UsdmStudyVersion = z.infer<typeof studyVersionSchema>;

export const usdmStudySchema = z.object({
  id: z.string().nullish(),
  name: z.string(),
  label: z.string().nullish(),
  description: z.string().nullish(),
  versions: z.array(studyVersionSchema).default([]),
  instanceType: z.string(),
});
export type UsdmStudy = z.infer<typeof usdmStudySchema>;

export const usdmWrapperSchema = z.object({
  study: usdmStudySchema,
  usdmVersion: z.string(),
  systemName: z.string().nullish(),
  systemVersion: z.string().nullish(),
});
export type UsdmWrapper = z.infer<typeof usdmWrapperSchema>;
