import type {
  UsdmActivity,
  UsdmBiomedicalConcept,
  UsdmBiomedicalConceptSurrogate,
  UsdmEncounter,
  UsdmScheduledActivityInstance,
  UsdmScheduleTimeline,
  UsdmStudyDesign,
  UsdmStudyVersion,
  UsdmTiming,
  UsdmWrapper,
} from "./model.js";

/**
 * Graph helpers over a parsed USDM wrapper: walk the schedule timeline,
 * order encounters and activities as a schedule of activities, and resolve
 * an activity's biomedical concepts from the StudyVersion pools. Shared by
 * the compiler and the protocol review UI.
 */

/** USDM-IG §6.3 recommends a single StudyVersion; edc-core uses the first. */
export function studyVersion(wrapper: UsdmWrapper): UsdmStudyVersion | undefined {
  return wrapper.study.versions[0];
}

export function primaryStudyDesign(version: UsdmStudyVersion): UsdmStudyDesign | undefined {
  return version.studyDesigns[0];
}

export function mainTimeline(design: UsdmStudyDesign): UsdmScheduleTimeline | undefined {
  return design.scheduleTimelines.find((t) => t.mainTimeline) ?? design.scheduleTimelines[0];
}

/**
 * Scheduled activity instances in execution order: follow defaultConditionId
 * from the entry point, then append any instances only reachable through
 * decision branches (in declaration order).
 */
export function scheduledActivityInstancesInOrder(
  timeline: UsdmScheduleTimeline,
): UsdmScheduledActivityInstance[] {
  const byId = new Map(timeline.instances.map((i) => [i.id, i]));
  const ordered: UsdmScheduledActivityInstance[] = [];
  const visited = new Set<string>();

  let cursor = byId.get(timeline.entryId);
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    if (cursor.instanceType === "ScheduledActivityInstance") ordered.push(cursor);
    cursor = cursor.defaultConditionId ? byId.get(cursor.defaultConditionId) : undefined;
  }
  for (const instance of timeline.instances) {
    if (!visited.has(instance.id) && instance.instanceType === "ScheduledActivityInstance") {
      ordered.push(instance);
    }
  }
  return ordered;
}

/** Order entities linked by previousId/nextId; falls back to array order. */
function chainOrder<
  T extends {
    id: string;
    previousId?: string | null | undefined;
    nextId?: string | null | undefined;
  },
>(entities: T[]): T[] {
  if (entities.length < 2) return [...entities];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const hasPrevious = new Set(
    entities.flatMap((e) => (e.nextId && byId.has(e.nextId) ? [e.nextId] : [])),
  );
  const head = entities.find((e) => !e.previousId && !hasPrevious.has(e.id));
  if (!head) return [...entities];

  const ordered: T[] = [];
  const visited = new Set<string>();
  let cursor: T | undefined = head;
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    ordered.push(cursor);
    cursor = cursor.nextId ? byId.get(cursor.nextId) : undefined;
  }
  for (const entity of entities) {
    if (!visited.has(entity.id)) ordered.push(entity);
  }
  return ordered;
}

/**
 * Encounters in schedule order: first appearance along the main timeline,
 * then unscheduled encounters in previous/next chain order.
 */
export function encountersInOrder(design: UsdmStudyDesign): UsdmEncounter[] {
  const byId = new Map(design.encounters.map((e) => [e.id, e]));
  const ordered: UsdmEncounter[] = [];
  const seen = new Set<string>();

  const timeline = mainTimeline(design);
  if (timeline) {
    for (const instance of scheduledActivityInstancesInOrder(timeline)) {
      if (!instance.encounterId || seen.has(instance.encounterId)) continue;
      const encounter = byId.get(instance.encounterId);
      if (!encounter) continue;
      seen.add(encounter.id);
      ordered.push(encounter);
    }
  }
  for (const encounter of chainOrder(design.encounters)) {
    if (!seen.has(encounter.id)) ordered.push(encounter);
  }
  return ordered;
}

/**
 * Top-level activities in SoA presentation order (previous/next chain).
 * Child activities (grouping members) are excluded; expand via childIds.
 */
export function activitiesInOrder(design: UsdmStudyDesign): UsdmActivity[] {
  const childIds = new Set(design.activities.flatMap((a) => a.childIds));
  return chainOrder(design.activities).filter((a) => !childIds.has(a.id));
}

/** Activities performed at an encounter, in main-timeline order. */
export function activitiesForEncounter(
  design: UsdmStudyDesign,
  encounterId: string,
): UsdmActivity[] {
  const timeline = mainTimeline(design);
  if (!timeline) return [];
  const byId = new Map(design.activities.map((a) => [a.id, a]));
  const ordered: UsdmActivity[] = [];
  const seen = new Set<string>();
  for (const instance of scheduledActivityInstancesInOrder(timeline)) {
    if (instance.encounterId !== encounterId) continue;
    for (const activityId of instance.activityIds) {
      if (seen.has(activityId)) continue;
      const activity = byId.get(activityId);
      if (!activity) continue;
      seen.add(activityId);
      ordered.push(activity);
    }
  }
  return ordered;
}

export interface ResolvedActivityConcepts {
  concepts: UsdmBiomedicalConcept[];
  surrogates: UsdmBiomedicalConceptSurrogate[];
}

/**
 * Resolve an activity's data specification from the StudyVersion pools.
 * Category members are flattened into `concepts` (after direct references,
 * deduplicated); surrogates are placeholders for concepts with no definition.
 */
export function bcsForActivity(
  version: UsdmStudyVersion,
  activity: UsdmActivity,
): ResolvedActivityConcepts {
  const conceptsById = new Map(version.biomedicalConcepts.map((bc) => [bc.id, bc]));
  const categoriesById = new Map(version.bcCategories.map((c) => [c.id, c]));
  const surrogatesById = new Map(version.bcSurrogates.map((s) => [s.id, s]));

  const concepts: UsdmBiomedicalConcept[] = [];
  const seen = new Set<string>();
  const addConcept = (id: string) => {
    if (seen.has(id)) return;
    const concept = conceptsById.get(id);
    if (!concept) return;
    seen.add(id);
    concepts.push(concept);
  };

  for (const id of activity.biomedicalConceptIds) addConcept(id);
  for (const categoryId of activity.bcCategoryIds) {
    for (const memberId of categoriesById.get(categoryId)?.memberIds ?? []) addConcept(memberId);
  }

  return {
    concepts,
    surrogates: activity.bcSurrogateIds.flatMap((id) => {
      const surrogate = surrogatesById.get(id);
      return surrogate ? [surrogate] : [];
    }),
  };
}

/** Timing whose id matches, searched across all of the design's timelines. */
export function timingById(design: UsdmStudyDesign, timingId: string): UsdmTiming | undefined {
  for (const timeline of design.scheduleTimelines) {
    const timing = timeline.timings.find((t) => t.id === timingId);
    if (timing) return timing;
  }
  return undefined;
}

/** Timings anchored on a scheduled instance (relativeFrom side). */
export function timingsForInstance(
  timeline: UsdmScheduleTimeline,
  instanceId: string,
): UsdmTiming[] {
  return timeline.timings.filter((t) => t.relativeFromScheduledInstanceId === instanceId);
}

export interface SoaRow {
  activity: UsdmActivity;
  children: UsdmActivity[];
  encounterIds: string[];
}

export interface SoaMatrix {
  encounters: UsdmEncounter[];
  rows: SoaRow[];
}

/**
 * The schedule of activities as a matrix: ordered encounters as columns,
 * ordered top-level activities as rows, each row carrying the encounters at
 * which the activity (or any of its children) is scheduled.
 */
export function soaMatrix(design: UsdmStudyDesign): SoaMatrix {
  const encounters = encountersInOrder(design);
  const byId = new Map(design.activities.map((a) => [a.id, a]));
  const timeline = mainTimeline(design);

  const scheduledAt = new Map<string, Set<string>>();
  if (timeline) {
    for (const instance of scheduledActivityInstancesInOrder(timeline)) {
      if (!instance.encounterId) continue;
      for (const activityId of instance.activityIds) {
        const set = scheduledAt.get(activityId) ?? new Set<string>();
        set.add(instance.encounterId);
        scheduledAt.set(activityId, set);
      }
    }
  }

  const rows: SoaRow[] = activitiesInOrder(design).map((activity) => {
    const children = activity.childIds.flatMap((id) => {
      const child = byId.get(id);
      return child ? [child] : [];
    });
    const encounterIds = new Set(scheduledAt.get(activity.id) ?? []);
    for (const child of children) {
      for (const id of scheduledAt.get(child.id) ?? []) encounterIds.add(id);
    }
    return {
      activity,
      children,
      encounterIds: encounters.map((e) => e.id).filter((id) => encounterIds.has(id)),
    };
  });

  return { encounters, rows };
}

/** Preferred display text: label when present, else name. */
export function displayLabel(entity: { name: string; label?: string | null | undefined }): string {
  return entity.label ?? entity.name;
}
