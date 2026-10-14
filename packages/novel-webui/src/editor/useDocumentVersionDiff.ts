import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

/**
 * Shared loader for one document version plus its paged diff. Used by the
 * workspace version history and by the review page; the query keys mirror
 * DocumentWorkspacePage so both surfaces share cache entries.
 */
export function useDocumentVersionDiff(versionId: string | null) {
  const version = useQuery({
    queryKey: ["document-version", versionId],
    queryFn: () => api.getDocumentVersion(versionId!),
    enabled: Boolean(versionId),
  });

  const diff = useInfiniteQuery({
    queryKey: ["document-version-diff", versionId],
    queryFn: ({ pageParam }) => api.getDocumentVersionDiff(versionId!, pageParam || null, 20),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Hunk payloads exist only once the server finished building the diff.
    enabled: Boolean(versionId && version.data?.diffStatus === "ready"),
  });

  return {
    version: version.data ?? null,
    versionLoading: version.isLoading,
    // Diffs are repaired asynchronously server-side; unavailable is terminal.
    diffPendingRepair: Boolean(version.data && version.data.diffStatus !== "ready"),
    diffPages: diff.data?.pages ?? [],
    diffLoading: version.isLoading || diff.isLoading || diff.isFetchingNextPage,
    diffFailed: diff.isError,
    diffHasMore: Boolean(diff.hasNextPage),
    loadMoreDiff: () => void diff.fetchNextPage(),
  };
}
