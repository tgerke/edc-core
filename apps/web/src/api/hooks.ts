import { type OdmFile, parseOdm } from "@edc-core/odm";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiError, api } from "./client.js";

export interface Me {
  id: string;
  username: string;
  fullName: string;
  isSystemAdmin: boolean;
  hasPassword: boolean;
  mustChangePassword: boolean;
}

export interface AuthConfigInfo {
  oidcEnabled: boolean;
  oidcOnly: boolean;
  providerLabel: string | null;
  passwordLoginEnabled: boolean;
}

export function useAuthConfig() {
  return useQuery<AuthConfigInfo>({
    queryKey: ["auth-config"],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => api<AuthConfigInfo>("/auth/config"),
  });
}

export interface StudySummary {
  id: string;
  oid: string;
  name: string;
  protocolName: string | null;
  status: string;
  createdAt: string;
}

export interface MetadataVersionSummary {
  id: string;
  version: number;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export function useMe() {
  return useQuery<Me | null>({
    queryKey: ["me"],
    retry: false,
    queryFn: async () => {
      try {
        return await api<Me>("/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { username: string; password: string }) =>
      api<{ token: string }>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
    // refetch (not just invalidate): the "me" query has no observer while the
    // login page is mounted, and navigation must not see the stale null.
    onSuccess: () => queryClient.refetchQueries({ queryKey: ["me"] }),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function useStudies() {
  return useQuery<StudySummary[]>({
    queryKey: ["studies"],
    queryFn: () => api<StudySummary[]>("/studies"),
  });
}

export function useCreateStudy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { oid: string; name: string; protocolName?: string }) =>
      api<StudySummary>("/studies", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["studies"] }),
  });
}

export function useMetadataVersions(studyId: string) {
  return useQuery<MetadataVersionSummary[]>({
    queryKey: ["metadata-versions", studyId],
    queryFn: () => api<MetadataVersionSummary[]>(`/studies/${studyId}/metadata-versions`),
  });
}

export function useImportOdm(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { content: string; note?: string }) =>
      api<{ id: string; version: number; warnings: unknown[] }>(
        `/studies/${studyId}/metadata-versions`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["metadata-versions", studyId] }),
  });
}

export interface Site {
  id: string;
  oid: string;
  name: string;
}

export interface SubjectSummary {
  id: string;
  subjectKey: string;
  status: string;
  siteId: string;
  siteName: string;
}

export interface MatrixCell {
  formInstanceId: string;
  status: string;
}

export interface Matrix {
  buildVersion: number | null;
  events: { oid: string; name: string; forms: { oid: string; name: string }[] }[];
  subjects: (SubjectSummary & {
    siteId: string;
    unblinded: boolean;
    cells: Record<string, MatrixCell | null>;
  })[];
}

export interface FormValue {
  item_group_oid: string;
  item_group_repeat_key: number;
  item_oid: string;
  version: number;
  value: string | null;
}

export interface OpenQuery {
  id: string;
  origin: "manual" | "system";
  checkOid: string | null;
  itemGroupRepeatKey: number | null;
  createdAt: string;
}

export interface SignatureManifestEntry {
  id: string;
  signerName: string;
  signerUsername: string;
  meaning: string;
  recordHash: string;
  signedAt: string;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
}

export interface FormData {
  context: {
    formInstanceId: string;
    formOid: string;
    status: string;
    subjectId: string;
    subjectKey: string;
    studyId: string;
    siteId: string;
    eventOid: string;
    eventRepeatKey: number;
  };
  buildVersion: number | null;
  values: FormValue[];
  /** Item OIDs whose values are blinded for the current viewer. */
  blindedItems: string[];
  openQueries: OpenQuery[];
  signatures: SignatureManifestEntry[];
  /** Present when this instance was captured through a site form variant. */
  variantDefinition: unknown | null;
}

export function useSites(studyId: string) {
  return useQuery<Site[]>({
    queryKey: ["sites", studyId],
    queryFn: () => api<Site[]>(`/studies/${studyId}/sites`),
  });
}

export function useMatrix(studyId: string) {
  return useQuery<Matrix>({
    queryKey: ["matrix", studyId],
    queryFn: () => api<Matrix>(`/studies/${studyId}/matrix`),
  });
}

export function useEnrollSubject(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { siteId: string; subjectKey: string; status?: "screening" | "enrolled" }) =>
      api<SubjectSummary>(`/studies/${studyId}/subjects`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["matrix", studyId] }),
  });
}

export function useTransitionSubject(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { subjectId: string; action: string; reason?: string }) =>
      api<SubjectSummary>(`/subjects/${input.subjectId}/status`, {
        method: "POST",
        body: JSON.stringify({
          action: input.action,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["matrix", studyId] }),
  });
}

export function useBreakBlind(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { subjectId: string; category: string; reason: string }) =>
      api<{ id: string }>(`/subjects/${input.subjectId}/unblind`, {
        method: "POST",
        body: JSON.stringify({ category: input.category, reason: input.reason }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["matrix", studyId] }),
  });
}

export function useEnsureForm() {
  return useMutation({
    mutationFn: (input: { subjectId: string; eventOid: string; formOid: string }) =>
      api<{ id: string }>(`/subjects/${input.subjectId}/forms`, {
        method: "POST",
        body: JSON.stringify({ eventOid: input.eventOid, formOid: input.formOid }),
      }),
  });
}

export function useFormData(formInstanceId: string) {
  return useQuery<FormData>({
    queryKey: ["form", formInstanceId],
    queryFn: () => api<FormData>(`/forms/${formInstanceId}`),
  });
}

export function useWriteItem(formInstanceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      itemGroupOid: string;
      itemGroupRepeatKey?: number;
      itemOid: string;
      value: string | null;
      reasonForChange?: string;
    }) => api(`/forms/${formInstanceId}/items`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["form", formInstanceId] });
      // Writes open/close system queries server-side.
      queryClient.invalidateQueries({ queryKey: ["queries"] });
    },
  });
}

export function useTransitionForm(formInstanceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: string) =>
      api(`/forms/${formInstanceId}/status`, {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["form", formInstanceId] });
      queryClient.invalidateQueries({ queryKey: ["matrix"] });
    },
  });
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actor: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
}

export interface AuditFilters {
  action?: string;
  entityType?: string;
  actor?: string;
  limit: number;
  offset: number;
}

export interface AuditPage {
  total: number;
  events: AuditEvent[];
  facets: { actions: string[]; entityTypes: string[] };
}

export function auditQueryString(filters: AuditFilters): string {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.entityType) params.set("entityType", filters.entityType);
  if (filters.actor) params.set("actor", filters.actor);
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  return params.toString();
}

export function useAudit(studyId: string, filters: AuditFilters) {
  return useQuery<AuditPage>({
    queryKey: ["audit", studyId, filters],
    placeholderData: (previous) => previous,
    queryFn: () => api<AuditPage>(`/studies/${studyId}/audit?${auditQueryString(filters)}`),
  });
}

export function useSignForm(formInstanceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      body:
        | { username: string; password: string; meaning: string }
        | { reauthGrant: string; meaning: string },
    ) => api(`/forms/${formInstanceId}/sign`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["form", formInstanceId] });
      queryClient.invalidateQueries({ queryKey: ["matrix"] });
    },
  });
}

export interface QueryMessage {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface QueryThread {
  id: string;
  formInstanceId: string;
  itemGroupOid: string | null;
  itemGroupRepeatKey: number | null;
  itemOid: string | null;
  origin: "manual" | "system";
  checkOid: string | null;
  status: "open" | "answered" | "closed";
  openedBy: string;
  createdAt: string;
  closedAt: string | null;
  messages: QueryMessage[];
}

export interface StudyQueryRow extends QueryThread {
  subjectKey: string;
  eventOid: string;
  formOid: string;
}

export function useFormQueries(formInstanceId: string) {
  return useQuery<QueryThread[]>({
    queryKey: ["queries", "form", formInstanceId],
    queryFn: () => api<QueryThread[]>(`/forms/${formInstanceId}/queries`),
  });
}

export function useStudyQueries(studyId: string, status?: string) {
  return useQuery<StudyQueryRow[]>({
    queryKey: ["queries", "study", studyId, status ?? "all"],
    queryFn: () =>
      api<StudyQueryRow[]>(`/studies/${studyId}/queries${status ? `?status=${status}` : ""}`),
  });
}

// ── Amendment migration ────────────────────────────────────────────────

export interface BuildDiffResponse {
  fromVersion: number;
  toVersion: number;
  diff: {
    events: { oid: string; name: string; kind: string; detail?: string }[];
    forms: { oid: string; name: string; kind: string; detail?: string }[];
    itemGroups: { oid: string; name: string; kind: string; detail?: string }[];
    items: {
      itemOid: string;
      itemGroupOid: string;
      name: string;
      kind: string;
      changes?: Record<string, unknown>;
    }[];
    codeLists: { oid: string; name: string; kind: string; detail?: string }[];
    editChecks: { oid: string; name: string; kind: string; detail?: string }[];
    hasChanges: boolean;
  };
}

export interface MigrationImpact {
  targetVersion: number;
  eligible: {
    total: number;
    byStatus: Record<string, number>;
    byFromVersion: Record<string, number>;
  };
  excluded: { signed: number; locked: number };
  diffs: { fromVersion: number; diff: BuildDiffResponse["diff"] }[];
  orphanedValues: { itemGroupOid: string; itemOid: string; valueCount: number }[];
  typeConflicts: {
    itemGroupOid: string;
    itemOid: string;
    from: string;
    to: string;
    nonCastableCount: number;
  }[];
  checksAddedOrChanged: string[];
}

export interface MigrationRun {
  id: string;
  status: "running" | "completed" | "completed_with_errors" | "failed";
  totalForms: number;
  processedForms: number;
  skippedForms: number;
  failedForms: number;
  errors: { formInstanceId: string; message: string }[];
  createdAt: string;
  finishedAt: string | null;
}

export function useBuildDiff(studyId: string, from: number | null, to: number | null) {
  return useQuery<BuildDiffResponse>({
    queryKey: ["build-diff", studyId, from, to],
    enabled: from !== null && to !== null && from !== to,
    queryFn: () => api<BuildDiffResponse>(`/studies/${studyId}/builds/diff?from=${from}&to=${to}`),
  });
}

export function useAnalyzeMigration(studyId: string) {
  return useMutation({
    mutationFn: (targetVersion: number) =>
      api<MigrationImpact>(`/studies/${studyId}/migrations/analyze`, {
        method: "POST",
        body: JSON.stringify({ targetVersion }),
      }),
  });
}

export function useStartMigration(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targetVersion: number) =>
      api<{ runId: string; totalForms: number }>(`/studies/${studyId}/migrations`, {
        method: "POST",
        body: JSON.stringify({ targetVersion }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["migrations", studyId] }),
  });
}

export function useMigrationRun(studyId: string, runId: string | null) {
  return useQuery<MigrationRun>({
    queryKey: ["migrations", studyId, runId],
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2000 : false),
    queryFn: () => api<MigrationRun>(`/studies/${studyId}/migrations/${runId}`),
  });
}

// ── Lab data import ────────────────────────────────────────────────────

export interface LabImportMapping {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LabImportIssueRow {
  line: number;
  subjectKey: string;
  testCode: string;
  outcome: string;
  message: string;
}

export interface LabImportPreview {
  totalRows: number;
  counts: Record<string, number>;
  issues: LabImportIssueRow[];
  issuesTruncated: boolean;
  formsTouched: number;
  formInstancesToCreate: number;
}

export interface LabImportRun {
  id: string;
  fileName: string | null;
  status: "running" | "completed" | "completed_with_errors" | "failed";
  totalRows: number;
  processedRows: number;
  counts: Record<string, number>;
  issues: LabImportIssueRow[];
  createdAt: string;
  finishedAt: string | null;
}

export function useLabImportMappings(studyId: string) {
  return useQuery<LabImportMapping[]>({
    queryKey: ["lab-import-mappings", studyId],
    queryFn: () => api<LabImportMapping[]>(`/studies/${studyId}/lab-import/mappings`),
  });
}

export function useSaveLabImportMapping(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; name: string; config: Record<string, unknown> }) =>
      input.id
        ? api<LabImportMapping>(`/studies/${studyId}/lab-import/mappings/${input.id}`, {
            method: "PUT",
            body: JSON.stringify({ name: input.name, config: input.config }),
          })
        : api<LabImportMapping>(`/studies/${studyId}/lab-import/mappings`, {
            method: "POST",
            body: JSON.stringify({ name: input.name, config: input.config }),
          }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["lab-import-mappings", studyId] }),
  });
}

export function useValidateLabImport(studyId: string) {
  return useMutation({
    mutationFn: (input: { mappingId: string; content: string }) =>
      api<LabImportPreview>(`/studies/${studyId}/lab-import/validate`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
}

export function useStartLabImport(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { mappingId: string; content: string; fileName?: string }) =>
      api<{ runId: string; totalRows: number }>(`/studies/${studyId}/lab-import/runs`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["lab-import-runs", studyId] }),
  });
}

export function useLabImportRuns(studyId: string) {
  return useQuery<LabImportRun[]>({
    queryKey: ["lab-import-runs", studyId],
    queryFn: () => api<LabImportRun[]>(`/studies/${studyId}/lab-import/runs`),
  });
}

export function useLabImportRun(studyId: string, runId: string | null) {
  return useQuery<LabImportRun>({
    queryKey: ["lab-import-runs", studyId, runId],
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2000 : false),
    queryFn: () => api<LabImportRun>(`/studies/${studyId}/lab-import/runs/${runId}`),
  });
}

// ── Medical coding ─────────────────────────────────────────────────────

export interface Dictionary {
  id: string;
  type: "MedDRA" | "WHODrug";
  version: string;
  termsCount: number;
  createdAt: string;
  createdBy?: string;
}

export interface CodingSettings {
  bindings: {
    dictionaryType: "MedDRA" | "WHODrug";
    dictionaryId: string;
    version: string;
    termsCount: number;
  }[];
  availableDictionaries: Dictionary[];
}

export interface CodingItem {
  formInstanceId: string;
  itemGroupOid: string;
  itemGroupRepeatKey: number;
  itemOid: string;
  subjectKey: string;
  eventOid: string;
  formOid: string;
  verbatim: string;
  dictionaryType: "MedDRA" | "WHODrug";
  status: "uncoded" | "stale" | "coded_auto" | "coded_manual";
  coding: {
    code: string;
    term: string;
    ptTerm: string | null;
    socTerm: string | null;
    atcCode: string | null;
    atcText: string | null;
    dictionaryVersion: string | null;
    verbatim: string;
    origin: string;
    createdAt: string;
  } | null;
}

export interface CodingSearchResult {
  id: string;
  code: string;
  term: string;
  ptTerm: string | null;
  socTerm: string | null;
  atcCode: string | null;
  atcText: string | null;
}

export interface CodingRunRow {
  id: string;
  status: "running" | "completed" | "completed_with_errors" | "failed";
  totalOccurrences: number;
  processedOccurrences: number;
  counts: Record<string, number>;
  issues: { subjectKey: string; itemOid: string; verbatim: string; message: string }[];
  createdAt: string;
  finishedAt: string | null;
}

export interface CodingOccurrenceInput {
  formInstanceId: string;
  itemGroupOid: string;
  itemGroupRepeatKey: number;
  itemOid: string;
  reason?: string;
}

export function useDictionaries(enabled: boolean) {
  return useQuery<Dictionary[]>({
    queryKey: ["dictionaries"],
    enabled,
    queryFn: () => api<Dictionary[]>("/dictionaries"),
  });
}

export function useUploadDictionary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: "MedDRA" | "WHODrug"; version: string; content: string }) =>
      api<Dictionary>("/dictionaries", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dictionaries"] }),
  });
}

export function useCodingSettings(studyId: string) {
  return useQuery<CodingSettings>({
    queryKey: ["coding-settings", studyId],
    queryFn: () => api<CodingSettings>(`/studies/${studyId}/coding/settings`),
  });
}

export function useSaveDictionaryBinding(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { dictionaryType: "MedDRA" | "WHODrug"; dictionaryId: string | null }) =>
      api<CodingSettings>(`/studies/${studyId}/coding/settings`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["coding-settings", studyId] });
      queryClient.invalidateQueries({ queryKey: ["coding-items", studyId] });
    },
  });
}

export function useCodingItems(studyId: string, status: string, type: string) {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (type !== "all") params.set("type", type);
  const qs = params.toString();
  return useQuery<CodingItem[]>({
    queryKey: ["coding-items", studyId, status, type],
    queryFn: () => api<CodingItem[]>(`/studies/${studyId}/coding/items${qs ? `?${qs}` : ""}`),
  });
}

export function useCodingSearch(studyId: string, type: "MedDRA" | "WHODrug", q: string) {
  return useQuery<CodingSearchResult[]>({
    queryKey: ["coding-search", studyId, type, q],
    enabled: q.trim().length >= 2,
    queryFn: () =>
      api<CodingSearchResult[]>(
        `/studies/${studyId}/coding/search?type=${type}&q=${encodeURIComponent(q)}`,
      ),
  });
}

export function useAssignCoding(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CodingOccurrenceInput & { termId: string }) =>
      api<unknown>(`/studies/${studyId}/coding/assign`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["coding-items", studyId] }),
  });
}

export function useClearCoding(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CodingOccurrenceInput) =>
      api<unknown>(`/studies/${studyId}/coding/clear`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["coding-items", studyId] }),
  });
}

export function useStartCodingRun(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ runId: string; totalOccurrences: number }>(`/studies/${studyId}/coding/runs`, {
        method: "POST",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["coding-runs", studyId] }),
  });
}

export function useCodingRuns(studyId: string) {
  return useQuery<CodingRunRow[]>({
    queryKey: ["coding-runs", studyId],
    queryFn: () => api<CodingRunRow[]>(`/studies/${studyId}/coding/runs`),
  });
}

export function useCodingRun(studyId: string, runId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery<CodingRunRow>({
    queryKey: ["coding-runs", studyId, runId],
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2000 : false),
    queryFn: () => api<CodingRunRow>(`/studies/${studyId}/coding/runs/${runId}`),
  });
  const status = query.data?.status;
  useEffect(() => {
    if (status && status !== "running") {
      queryClient.invalidateQueries({ queryKey: ["coding-items", studyId] });
    }
  }, [status, studyId, queryClient]);
  return query;
}

// ── Notifications ──────────────────────────────────────────────────────

export interface NotificationRow {
  id: string;
  studyId: string | null;
  type:
    | "query.opened"
    | "query.answered"
    | "form.awaiting_signature"
    | "form.overdue"
    | "security.anomaly";
  title: string;
  body: string;
  payload: {
    formInstanceId?: string;
    queryId?: string;
    subjectKey?: string;
    formOid?: string;
    anomalyId?: string;
  };
  readAt: string | null;
  createdAt: string;
}

// Polling, not push: consistent with the rest of the app (TanStack Query
// invalidation everywhere, no SSE/websocket channel exists).
export function useNotifications(enabled: boolean) {
  return useQuery<NotificationRow[]>({
    queryKey: ["notifications"],
    enabled,
    queryFn: () => api<NotificationRow[]>("/notifications?limit=20"),
  });
}

export function useUnreadCount() {
  return useQuery<{ count: number }>({
    queryKey: ["notifications", "unread-count"],
    refetchInterval: 30_000,
    queryFn: () => api<{ count: number }>("/notifications/unread-count"),
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api("/notifications/read-all", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function usePermissions(studyId: string, siteId?: string) {
  return useQuery<string[]>({
    queryKey: ["permissions", studyId, siteId ?? ""],
    queryFn: async () =>
      (
        await api<{ permissions: string[] }>(
          `/studies/${studyId}/permissions${siteId ? `?siteId=${siteId}` : ""}`,
        )
      ).permissions,
  });
}

/**
 * The study's sites at which the user holds the permission. Site-scoped
 * grants confer nothing at study scope, so any "can they do this anywhere"
 * gate has to ask per site; the query keys match usePermissions, so results
 * are shared with per-row checks.
 */
export function useSitesWithPermission(studyId: string, permission: string) {
  const { data: sites } = useSites(studyId);
  const results = useQueries({
    queries: (sites ?? []).map((site) => ({
      queryKey: ["permissions", studyId, site.id],
      queryFn: async () =>
        (await api<{ permissions: string[] }>(`/studies/${studyId}/permissions?siteId=${site.id}`))
          .permissions,
    })),
  });
  return {
    sites: (sites ?? []).filter((_, i) => results[i]?.data?.includes(permission)),
    isPending: sites === undefined || results.some((r) => r.isPending),
  };
}

export function useOpenQuery(formInstanceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemGroupOid?: string; itemOid?: string; body: string }) =>
      api(`/forms/${formInstanceId}/queries`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["queries"] });
      queryClient.invalidateQueries({ queryKey: ["form", formInstanceId] });
    },
  });
}

export function useQueryAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      queryId: string;
      action: "answer" | "reopen" | "close";
      body?: string;
    }) =>
      api(`/queries/${input.queryId}/${input.action}`, {
        method: "POST",
        body: JSON.stringify(input.body ? { body: input.body } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["queries"] });
      queryClient.invalidateQueries({ queryKey: ["form"] });
    },
  });
}

export function useStudyBuild(studyId: string, version: number) {
  return useQuery<OdmFile>({
    queryKey: ["study-build", studyId, version],
    queryFn: async () => {
      const raw = await api<unknown>(
        `/studies/${studyId}/metadata-versions/${version}/odm?serialization=json`,
      );
      return parseOdm(typeof raw === "string" ? raw : JSON.stringify(raw));
    },
  });
}

export interface SnapshotColumn {
  column: string;
  itemOid: string;
  dataType: string;
  label?: string;
}

export interface SnapshotTable {
  table: string;
  kind: "core" | "dataset";
  itemGroupOid?: string;
  label?: string;
  rows: number;
  columns?: SnapshotColumn[];
}

export interface SnapshotManifest {
  schema: string;
  metadataVersion: number;
  tables: SnapshotTable[];
}

export interface Snapshot {
  id: string;
  note: string | null;
  status: "pending" | "published" | "failed";
  schemaName: string;
  lakeVersion: string | null;
  manifest: SnapshotManifest | null;
  error: string | null;
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export function useSnapshots(studyId: string) {
  return useQuery<Snapshot[]>({
    queryKey: ["snapshots", studyId],
    queryFn: async () =>
      (await api<{ snapshots: Snapshot[] }>(`/studies/${studyId}/snapshots`)).snapshots,
  });
}

export function usePublishSnapshot(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { note?: string }) =>
      api<Snapshot>(`/studies/${studyId}/snapshots`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["snapshots", studyId] }),
  });
}

export interface WorkbenchResult {
  executionId: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  lakeVersion: string;
}

export function useRunSql(studyId: string) {
  return useMutation({
    mutationFn: (body: { snapshotId: string; sql: string }) =>
      api<WorkbenchResult>(`/studies/${studyId}/workbench/sql`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

export type ScriptLanguage = "r" | "python";

export interface SavedScript {
  id: string;
  name: string;
  language: ScriptLanguage | "sql";
  version: number;
  content: string;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkbenchExecution {
  id: string;
  snapshotId: string;
  scriptId: string | null;
  scriptVersion: number | null;
  language: ScriptLanguage | "sql";
  content: string;
  status: "succeeded" | "failed";
  stdout: string | null;
  error: string | null;
  result: { columns: string[]; rows: unknown[][] } | null;
  elapsedMs: number | null;
  executedBy: string;
  executedAt: string;
}

export function useScripts(studyId: string) {
  return useQuery<SavedScript[]>({
    queryKey: ["workbench-scripts", studyId],
    queryFn: async () =>
      (await api<{ scripts: SavedScript[] }>(`/studies/${studyId}/workbench/scripts`)).scripts,
  });
}

export function useSaveScript(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; language: ScriptLanguage | "sql"; content: string }) =>
      api<SavedScript>(`/studies/${studyId}/workbench/scripts`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workbench-scripts", studyId] }),
  });
}

export function useRunScript(studyId: string, language: ScriptLanguage) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      snapshotId: string;
      content: string;
      scriptId?: string;
      scriptVersion?: number;
    }) =>
      api<WorkbenchExecution>(`/studies/${studyId}/workbench/${language}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workbench-executions", studyId] }),
  });
}

export function useExecutions(studyId: string) {
  return useQuery<WorkbenchExecution[]>({
    queryKey: ["workbench-executions", studyId],
    queryFn: async () =>
      (await api<{ executions: WorkbenchExecution[] }>(`/studies/${studyId}/workbench/executions`))
        .executions,
  });
}

export interface QueryBatchTarget {
  subjectKey: string;
  formOid: string;
  eventOid?: string;
  eventRepeatKey?: number;
  formRepeatKey?: number;
  itemGroupOid?: string;
  itemGroupRepeatKey?: number;
  itemOid?: string;
  snapshotValue?: string | null;
  message?: string;
}

export interface QueryBatchRowResult {
  index: number;
  outcome: "created" | "would_create" | "skipped";
  queryId?: string;
  formInstanceId?: string;
  reason?: string;
}

export interface QueryBatchResult {
  batchId: string;
  results: QueryBatchRowResult[];
  created: number;
  skipped: number;
}

export function useCreateQueryBatch(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      dryRun?: boolean;
      force?: boolean;
      message: string;
      executionId?: string;
      targets: QueryBatchTarget[];
    }) =>
      api<QueryBatchResult>(`/studies/${studyId}/queries/batch`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (_result, variables) => {
      if (!variables.dryRun) {
        void queryClient.invalidateQueries({ queryKey: ["queries"] });
      }
    },
  });
}

// ── RTSM integration ───────────────────────────────────────────────────

export interface RtsmConfig {
  id: string;
  eventOid: string;
  formOid: string;
  itemGroupOid: string;
  itemOid: string;
  enabled: boolean;
  updatedAt: string;
}

export interface RtsmKey {
  id: string;
  label: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface MintedRtsmKey extends RtsmKey {
  /** The raw bearer token; shown exactly once, never retrievable again. */
  token: string;
}

export interface RtsmEvent {
  id: string;
  subjectKey: string;
  randomizationId: string;
  payload: Record<string, unknown>;
  outcome: "applied" | "duplicate" | "conflict" | "rejected";
  reason: string | null;
  blinded: boolean;
  createdAt: string;
}

export function useRtsmConfig(studyId: string) {
  return useQuery<RtsmConfig | null>({
    queryKey: ["rtsm-config", studyId],
    queryFn: () => api<RtsmConfig | null>(`/studies/${studyId}/rtsm/config`),
  });
}

export function useSaveRtsmConfig(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      eventOid: string;
      formOid: string;
      itemGroupOid: string;
      itemOid: string;
      enabled: boolean;
    }) =>
      api<RtsmConfig>(`/studies/${studyId}/rtsm/config`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rtsm-config", studyId] }),
  });
}

export function useRtsmKeys(studyId: string) {
  return useQuery<RtsmKey[]>({
    queryKey: ["rtsm-keys", studyId],
    queryFn: () => api<RtsmKey[]>(`/studies/${studyId}/rtsm/keys`),
  });
}

export function useMintRtsmKey(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { label: string; expiresAt?: string }) =>
      api<MintedRtsmKey>(`/studies/${studyId}/rtsm/keys`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rtsm-keys", studyId] }),
  });
}

export function useRevokeRtsmKey(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      api<{ ok: boolean }>(`/studies/${studyId}/rtsm/keys/${keyId}/revoke`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rtsm-keys", studyId] }),
  });
}

export function useRtsmEvents(studyId: string) {
  return useQuery<RtsmEvent[]>({
    queryKey: ["rtsm-events", studyId],
    queryFn: () => api<RtsmEvent[]>(`/studies/${studyId}/rtsm/events`),
  });
}

// ── User administration ────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  status: "active" | "locked" | "deactivated";
  isSystemAdmin: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  ssoLinked: boolean;
  lockedUntil: string | null;
  passwordChangedAt: string;
  createdAt: string;
}

export function useAdminUsers() {
  return useQuery<AdminUser[]>({
    queryKey: ["admin-users"],
    queryFn: () => api<AdminUser[]>("/admin/users"),
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      username: string;
      email: string;
      fullName: string;
      isSystemAdmin?: boolean;
      auth: "password" | "sso";
    }) =>
      api<AdminUser & { temporaryPassword?: string }>("/admin/users", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });
}

export function useUserAction(action: "deactivate" | "reactivate" | "unlock" | "reset-password") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<AdminUser & { temporaryPassword?: string }>(`/admin/users/${userId}/${action}`, {
        method: "POST",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });
}

export function useSetSystemAdmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; isSystemAdmin: boolean }) =>
      api<AdminUser>(`/admin/users/${input.userId}/system-admin`, {
        method: "POST",
        body: JSON.stringify({ isSystemAdmin: input.isSystemAdmin }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });
}

// ── Access log ─────────────────────────────────────────────────────────

export interface AccessLogEntry {
  id: string;
  occurredAt: string;
  user: string | null;
  userName: string | null;
  method: string;
  path: string;
  route: string | null;
  statusCode: number;
  ip: string | null;
  userAgent: string | null;
  sessionId: string | null;
  durationMs: number | null;
}

export interface AccessLogFilters {
  user?: string;
  ip?: string;
  path?: string;
  status?: string;
  limit: number;
  offset: number;
}

export interface AccessLogPage {
  total: number;
  entries: AccessLogEntry[];
}

export function accessLogQueryString(filters: AccessLogFilters): string {
  const params = new URLSearchParams();
  if (filters.user) params.set("user", filters.user);
  if (filters.ip) params.set("ip", filters.ip);
  if (filters.path) params.set("path", filters.path);
  if (filters.status) params.set("status", filters.status);
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  return params.toString();
}

export function useAccessLog(filters: AccessLogFilters) {
  return useQuery<AccessLogPage>({
    queryKey: ["access-log", filters],
    placeholderData: (previous) => previous,
    queryFn: () => api<AccessLogPage>(`/admin/access-log?${accessLogQueryString(filters)}`),
  });
}

// ── Security anomalies ─────────────────────────────────────────────────

export type AnomalyKind = "failed_login_burst" | "lockout" | "session_binding_violation";

export interface SecurityAnomaly {
  id: string;
  detectedAt: string;
  kind: AnomalyKind;
  severity: "warning" | "critical";
  user: string | null;
  ip: string | null;
  summary: string;
  details: Record<string, unknown>;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedNote: string | null;
}

export interface AnomalyFilters {
  status?: "open" | "acknowledged";
  kind?: AnomalyKind;
  limit: number;
  offset: number;
}

export interface AnomalyPage {
  total: number;
  entries: SecurityAnomaly[];
}

export function anomalyQueryString(filters: AnomalyFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.kind) params.set("kind", filters.kind);
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  return params.toString();
}

export function useSecurityAnomalies(filters: AnomalyFilters) {
  return useQuery<AnomalyPage>({
    queryKey: ["security-anomalies", filters],
    placeholderData: (previous) => previous,
    queryFn: () => api<AnomalyPage>(`/admin/security-anomalies?${anomalyQueryString(filters)}`),
  });
}

export function useAcknowledgeAnomaly() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { anomalyId: string; note?: string }) =>
      api(`/admin/security-anomalies/${input.anomalyId}/acknowledge`, {
        method: "POST",
        body: JSON.stringify(input.note ? { note: input.note } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["security-anomalies"] }),
  });
}

// ── Study team ─────────────────────────────────────────────────────────

export interface RoleInfo {
  name: string;
  description: string;
}

export interface StudyMember {
  grantId: string;
  userId: string;
  username: string;
  fullName: string;
  email: string;
  userStatus: "active" | "locked" | "deactivated";
  roleName: string;
  siteId: string | null;
  siteOid: string | null;
  siteName: string | null;
  grantedAt: string;
  grantedBy: string;
}

export interface UserMatch {
  id: string;
  username: string;
  fullName: string;
  email: string;
}

export function useRoles() {
  return useQuery<RoleInfo[]>({
    queryKey: ["roles"],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => api<RoleInfo[]>("/roles"),
  });
}

export function useStudyMembers(studyId: string) {
  return useQuery<StudyMember[]>({
    queryKey: ["members", studyId],
    queryFn: () => api<StudyMember[]>(`/studies/${studyId}/members`),
  });
}

export function useUserSearch(studyId: string, query: string) {
  return useQuery<UserMatch[]>({
    queryKey: ["user-search", studyId, query],
    enabled: query.trim().length >= 2,
    queryFn: () =>
      api<UserMatch[]>(`/studies/${studyId}/users?query=${encodeURIComponent(query.trim())}`),
  });
}

export function useGrantRole(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; roleName: string; siteId?: string }) =>
      api<{ id: string }>(`/studies/${studyId}/roles`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members", studyId] }),
  });
}

export function useRevokeGrant(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) =>
      api(`/studies/${studyId}/roles/${grantId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members", studyId] }),
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api<{ ok: boolean }>("/auth/change-password", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.refetchQueries({ queryKey: ["me"] }),
  });
}

// --- Protocol-first build path (USDM) --------------------------------------

export interface ProtocolVersionSummary {
  id: string;
  version: number;
  usdmVersion: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ProtocolConceptStatus {
  usdmId: string;
  name: string;
  conceptCode?: string;
  kind: "concept" | "surrogate";
  status: "resolved" | "draft";
  itemOids: string[];
}

export interface ProtocolSoaSummary {
  encounters: { usdmId: string; label: string; timingLabel?: string; windowLabel?: string }[];
  rows: {
    usdmId: string;
    label: string;
    isGroupHeading: boolean;
    encounterIds: string[];
    concepts: ProtocolConceptStatus[];
  }[];
  warnings: { severity: string; path: string; message: string }[];
  unresolvedCount: number;
}

export interface ProtocolVersionDetail extends ProtocolVersionSummary {
  package: unknown;
  compilation: {
    id: string;
    status: "in_review" | "published" | "discarded";
    unresolvedCount: number;
    publishedMetadataVersionId: string | null;
    candidate: unknown;
    warnings: unknown[];
  } | null;
  soa: ProtocolSoaSummary | null;
}

export function useProtocolVersions(studyId: string) {
  return useQuery<ProtocolVersionSummary[]>({
    queryKey: ["protocol-versions", studyId],
    queryFn: () => api<ProtocolVersionSummary[]>(`/studies/${studyId}/protocol-versions`),
  });
}

export function useProtocolVersion(studyId: string, version: string) {
  return useQuery<ProtocolVersionDetail>({
    queryKey: ["protocol-version", studyId, version],
    queryFn: () => api<ProtocolVersionDetail>(`/studies/${studyId}/protocol-versions/${version}`),
  });
}

export function useImportProtocol(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { content: string; note?: string }) =>
      api<{
        id: string;
        version: number;
        compilationId: string;
        unresolvedCount: number;
        warnings: unknown[];
      }>(`/studies/${studyId}/protocol-versions`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["protocol-versions", studyId] }),
  });
}

export interface DraftItemResolution {
  itemOid: string;
  name?: string;
  question?: string;
  dataType?: string;
  length?: number | null;
  mandatory?: boolean;
  codeListTerms?: { codedValue: string; decode?: string }[];
}

export function useResolveDraftItems(studyId: string, version: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { resolutions: DraftItemResolution[] }) =>
      api<{ unresolvedCount: number }>(
        `/studies/${studyId}/protocol-versions/${version}/compilation`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["protocol-version", studyId, version] }),
  });
}

export function usePublishCompilation(studyId: string, version: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ metadataVersionId: string; buildVersion: number }>(
        `/studies/${studyId}/protocol-versions/${version}/compilation/publish`,
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["protocol-version", studyId, version] });
      queryClient.invalidateQueries({ queryKey: ["metadata-versions", studyId] });
    },
  });
}

// --- Site form variants (BYOFW half B) -------------------------------------

export interface VariantItemRef {
  itemOid: string;
  mandatory: boolean;
  orderNumber: number;
  displayLabel?: string;
}

export interface VariantForm {
  oid: string;
  name: string;
  sections: { label?: string; itemRefs: VariantItemRef[] }[];
}

export interface SiteVariantDefinition {
  events: { eventOid: string; forms: VariantForm[] }[];
}

export interface SiteVariantVersionSummary {
  id: string;
  version: number;
  status: "draft" | "submitted" | "approved" | "changes_requested" | "retired" | "stale";
  metadataVersionId: string;
  submittedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface SiteVariant {
  id: string;
  name: string;
  siteId: string;
  versions: SiteVariantVersionSummary[];
  latest: (SiteVariantVersionSummary & { definition: SiteVariantDefinition }) | null;
}

export interface VariantIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export function useSiteVariants(studyId: string, siteId: string) {
  return useQuery<SiteVariant[]>({
    queryKey: ["site-variants", studyId, siteId],
    queryFn: () => api<SiteVariant[]>(`/studies/${studyId}/sites/${siteId}/form-variants`),
    enabled: siteId !== "",
  });
}

export function useCreateVariant(studyId: string, siteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; seedEventOids?: string[] }) =>
      api<{
        variantId: string;
        versionId: string;
        version: number;
        definition: SiteVariantDefinition;
        issues: VariantIssue[];
      }>(`/studies/${studyId}/sites/${siteId}/form-variants`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["site-variants", studyId, siteId] }),
  });
}

export function useSaveVariantVersion(studyId: string, siteId: string, variantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { definition: SiteVariantDefinition }) =>
      api<{ versionId: string; version: number; issues: VariantIssue[] }>(
        `/studies/${studyId}/sites/${siteId}/form-variants/${variantId}/versions`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["site-variants", studyId, siteId] }),
  });
}

export function useSubmitVariantVersion(studyId: string, siteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      api<{ status: string }>(
        `/studies/${studyId}/sites/${siteId}/form-variants/versions/${versionId}/submit`,
        { method: "POST" },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["site-variants", studyId, siteId] }),
  });
}

export function useValidateVariant(studyId: string, siteId: string) {
  return useMutation({
    mutationFn: (body: { definition: SiteVariantDefinition }) =>
      api<{ issues: VariantIssue[] }>(
        `/studies/${studyId}/sites/${siteId}/form-variants/validate`,
        { method: "POST", body: JSON.stringify(body) },
      ),
  });
}

export interface VariantApproval {
  versionId: string;
  variantId: string;
  name: string;
  siteId: string;
  version: number;
  status: string;
  submittedAt: string | null;
  definition: SiteVariantDefinition;
  metadataVersionId: string;
}

export function useVariantApprovals(studyId: string) {
  return useQuery<VariantApproval[]>({
    queryKey: ["variant-approvals", studyId],
    queryFn: () => api<VariantApproval[]>(`/studies/${studyId}/form-variant-approvals`),
  });
}

export function useVariantDecision(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      versionId: string;
      action: "approve" | "request-changes" | "retire";
      note?: string;
    }) =>
      api<{ status: string }>(
        `/studies/${studyId}/form-variants/versions/${input.versionId}/${input.action}`,
        { method: "POST", body: JSON.stringify({ note: input.note }) },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["variant-approvals", studyId] }),
  });
}

export function useEffectiveForms(studyId: string, siteId: string, eventOid: string) {
  return useQuery<
    | { source: "variant"; variantVersionId: string; forms: { oid: string; name: string }[] }
    | { source: "standard" }
  >({
    queryKey: ["effective-forms", studyId, siteId, eventOid],
    queryFn: () => api(`/studies/${studyId}/sites/${siteId}/effective-forms?eventOid=${eventOid}`),
    enabled: siteId !== "" && eventOid !== "",
  });
}
