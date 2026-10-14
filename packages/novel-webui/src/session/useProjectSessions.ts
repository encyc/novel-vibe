import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { ChatSession, SessionPage } from "../types";

const PAGE_SIZE = 20;

function sessionQueryKey(projectId: string, status: "active" | "archived" = "active", search = "") {
  return ["sessions", projectId, status, search] as const;
}

export function sessionMessagesQueryKey(sessionId: string) {
  return ["session-messages", sessionId] as const;
}

export function useSessionMessages(sessionId: string | null) {
  const query = useInfiniteQuery({
    queryKey: sessionMessagesQueryKey(sessionId ?? "none"),
    queryFn: ({ pageParam }) => api.listSessionMessages(sessionId!, {
      cursor: pageParam || undefined,
      limit: 30,
    }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(sessionId),
  });
  const messages = useMemo(
    () => [...(query.data?.pages ?? [])].reverse().flatMap((page) => page.items),
    [query.data],
  );
  return {
    fetchOlder: query.fetchNextPage,
    hasOlder: query.hasNextPage,
    loading: query.isLoading,
    loadingOlder: query.isFetchingNextPage,
    messages,
  };
}

export function useProjectSessions(projectId: string, userId: string, writable = true) {
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [managerStatus, setManagerStatus] = useState<"active" | "archived">("active");
  const autoCreateAttempt = useRef<string | null>(null);

  const sessionsQuery = useInfiniteQuery({
    queryKey: sessionQueryKey(projectId, "active"),
    queryFn: ({ pageParam }) => api.listSessions(projectId, {
      cursor: pageParam || undefined,
      limit: PAGE_SIZE,
      status: "active",
    }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(projectId),
  });

  const managerQuery = useInfiniteQuery({
    queryKey: sessionQueryKey(projectId, managerStatus, search),
    queryFn: ({ pageParam }) => api.listSessions(projectId, {
      cursor: pageParam || undefined,
      limit: PAGE_SIZE,
      search: search || undefined,
      status: managerStatus,
    }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(projectId && (search || managerStatus === "archived")),
  });

  const sessions = useMemo(
    () => sessionsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [sessionsQuery.data],
  );
  const managerSessions = search || managerStatus === "archived"
    ? managerQuery.data?.pages.flatMap((page) => page.items) ?? []
    : sessions;
  const activeSessionId = sessionsQuery.data?.pages[0]?.activeSessionId ?? null;

  const createMutation = useMutation({
    mutationFn: () => api.createSession(projectId),
    onSuccess: (session) => {
      setSelectedSessionId(session.id);
      queryClient.setQueryData<InfiniteData<SessionPage, string>>(
        sessionQueryKey(projectId, "active"),
        (data) => data ? {
          ...data,
          pages: data.pages.map((page, index) => index === 0 ? {
            ...page,
            activeSessionId: session.id,
            items: [session, ...page.items.filter((item) => item.id !== session.id)],
          } : page),
        } : { pages: [{ items: [session], nextCursor: null, activeSessionId: session.id }], pageParams: [""] },
      );
    },
  });

  useEffect(() => {
    setSelectedSessionId(null);
    setSearch("");
    setManagerStatus("active");
    autoCreateAttempt.current = null;
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !userId) return;
    const remembered = window.localStorage.getItem(`novel-vibe:session:${userId}:${projectId}`);
    if (remembered) setSelectedSessionId(remembered);
  }, [projectId, userId]);

  useEffect(() => {
    if (!projectId || !userId || !selectedSessionId || !sessions.some((session) => session.id === selectedSessionId)) return;
    window.localStorage.setItem(`novel-vibe:session:${userId}:${projectId}`, selectedSessionId);
  }, [projectId, selectedSessionId, sessions, userId]);

  useEffect(() => {
    if (!sessionsQuery.isSuccess || createMutation.isPending) return;
    if (sessions.length === 0) {
      if (writable && autoCreateAttempt.current !== projectId) {
        autoCreateAttempt.current = projectId;
        createMutation.mutate();
      }
      return;
    }
    if (!selectedSessionId || (managerStatus === "active" && !sessions.some((session) => session.id === selectedSessionId))) {
      setSelectedSessionId(activeSessionId ?? sessions[0]?.id ?? null);
    }
  }, [activeSessionId, createMutation, managerStatus, projectId, selectedSessionId, sessions, sessionsQuery.isSuccess, writable]);

  const selectMutation = useMutation({
    mutationFn: (session: ChatSession) => session.lifecycleStatus === "archived" ? Promise.resolve(session) : api.openSession(session.id),
    onMutate: (session) => setSelectedSessionId(session.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sessions", projectId] });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (sessionId: string) => api.archiveSession(sessionId),
    onSuccess: async (_, sessionId) => {
      if (selectedSessionId === sessionId) setSelectedSessionId(null);
      await queryClient.invalidateQueries({ queryKey: ["sessions", projectId] });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (sessionId: string) => api.restoreSession(sessionId),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["sessions", projectId] }),
  });

  const renameMutation = useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      api.renameSession(sessionId, title),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sessions", projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => api.deleteSession(sessionId),
    onSuccess: async (_, deletedId) => {
      if (selectedSessionId === deletedId) setSelectedSessionId(null);
      await queryClient.invalidateQueries({ queryKey: ["sessions", projectId] });
    },
  });

  const currentSession = [...sessions, ...managerSessions].find((session) => session.id === selectedSessionId) ?? null;

  return {
    activeSessionId,
    archiveSession: archiveMutation.mutateAsync,
    createSession: createMutation.mutateAsync,
    creating: createMutation.isPending,
    currentSession,
    deleteSession: deleteMutation.mutateAsync,
    deleting: deleteMutation.isPending,
    fetchNextManagerPage: search || managerStatus === "archived" ? managerQuery.fetchNextPage : sessionsQuery.fetchNextPage,
    hasNextManagerPage: search || managerStatus === "archived" ? managerQuery.hasNextPage : sessionsQuery.hasNextPage,
    managerLoading: search || managerStatus === "archived" ? managerQuery.isLoading : sessionsQuery.isLoading,
    managerSessions,
    managerStatus,
    recentSessions: sessions.slice(0, 5),
    renameSession: (sessionId: string, title: string) => renameMutation.mutateAsync({ sessionId, title }),
    restoreSession: restoreMutation.mutateAsync,
    renaming: renameMutation.isPending,
    search,
    selectSession: (sessionId: string) => {
      const session = [...sessions, ...managerSessions].find((item) => item.id === sessionId);
      return session ? selectMutation.mutateAsync(session) : Promise.resolve(null);
    },
    selecting: selectMutation.isPending,
    sessions,
    sessionsLoading: sessionsQuery.isLoading,
    setSearch,
    setManagerStatus,
  } satisfies Record<string, unknown> & {
    currentSession: ChatSession | null;
    managerSessions: ChatSession[];
    recentSessions: ChatSession[];
    sessions: ChatSession[];
  };
}
