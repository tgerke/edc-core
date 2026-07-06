import { type OdmFile, parseOdm } from "@edc-core/odm";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./client.js";

export interface Me {
  id: string;
  username: string;
  fullName: string;
  isSystemAdmin: boolean;
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
  createdAt: string;
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
  openQueries: OpenQuery[];
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["form", formInstanceId] }),
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
