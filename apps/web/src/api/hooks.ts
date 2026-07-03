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
