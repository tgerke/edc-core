import { type OdmFile, parseOdm } from "@edc-core/odm";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./client.js";

export interface Me {
  id: string;
  username: string;
  fullName: string;
  isSystemAdmin: boolean;
  hasPassword: boolean;
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
  subjects: (SubjectSummary & { cells: Record<string, MatrixCell | null> })[];
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
    mutationFn: (body: { siteId: string; subjectKey: string }) =>
      api<SubjectSummary>(`/studies/${studyId}/subjects`, {
        method: "POST",
        body: JSON.stringify(body),
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

// ── Notifications ──────────────────────────────────────────────────────

export interface NotificationRow {
  id: string;
  studyId: string;
  type: "query.opened" | "query.answered" | "form.awaiting_signature" | "form.overdue";
  title: string;
  body: string;
  payload: { formInstanceId?: string; queryId?: string; subjectKey?: string; formOid?: string };
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

export interface SavedScript {
  id: string;
  name: string;
  language: "r" | "sql";
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
  language: "r";
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
    mutationFn: (body: { name: string; language: "r" | "sql"; content: string }) =>
      api<SavedScript>(`/studies/${studyId}/workbench/scripts`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workbench-scripts", studyId] }),
  });
}

export function useRunR(studyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      snapshotId: string;
      content: string;
      scriptId?: string;
      scriptVersion?: number;
    }) =>
      api<WorkbenchExecution>(`/studies/${studyId}/workbench/r`, {
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
