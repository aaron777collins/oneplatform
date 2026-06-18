/**
 * StorageBrowserPage — browse MinIO/S3 buckets and their objects.
 *
 * Route: /settings/storage
 *
 * Features:
 *   - List buckets; select a bucket to enter it.
 *   - Folder-like navigation via common prefixes (delimiter "/").
 *   - Breadcrumb trail shows current prefix depth; click a segment to go up.
 *   - Object table: name, size (human-readable), last modified, content type.
 *   - Download (pre-signed URL opened in a new tab).
 *   - Delete with confirmation dialog.
 *   - Client-side filename search / filter.
 *   - Empty state when a bucket or prefix has no objects.
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  HardDrive,
  Folder,
  File,
  Download,
  Trash2,
  Search,
  ChevronRight,
  ArrowLeft,
} from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// Types — mirror the storage API response shapes
// ---------------------------------------------------------------------------

interface StorageBucket {
  name: string;
  createdAt: string;
}

interface StorageObject {
  key: string;
  size: number | null;
  lastModified: string | null;
  contentType: string | null;
  etag: string | null;
  isFolder: boolean;
}

interface ListObjectsResult {
  objects: StorageObject[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Formats bytes into a human-readable string (B, KB, MB, GB, TB). */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const exponent = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Returns the display name for an object within the current prefix context.
 * For a key "logs/2024/app.log" when the current prefix is "logs/2024/",
 * this returns "app.log". For folder entries, the trailing slash is stripped.
 */
function displayName(key: string, currentPrefix: string): string {
  const relative = key.startsWith(currentPrefix) ? key.slice(currentPrefix.length) : key;
  return relative.endsWith("/") ? relative.slice(0, -1) : relative;
}

// ---------------------------------------------------------------------------
// StorageBrowserPage
// ---------------------------------------------------------------------------

export function StorageBrowserPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  // Navigation state
  const [selectedBucket, setSelectedBucket] = React.useState<string | null>(null);
  const [currentPrefix, setCurrentPrefix] = React.useState<string>("");
  const [searchQuery, setSearchQuery] = React.useState<string>("");

  // Deletion state
  const [deleteTarget, setDeleteTarget] = React.useState<StorageObject | null>(null);

  // -------------------------------------------------------------------------
  // Bucket list query
  // -------------------------------------------------------------------------

  const bucketsQuery = useQuery({
    queryKey: ["storage-buckets"],
    queryFn: ({ signal }) =>
      client.get<{ data: StorageBucket[] }>("/v1/storage/buckets", undefined, { signal }),
  });

  const buckets = bucketsQuery.data?.data ?? [];

  // -------------------------------------------------------------------------
  // Object list query — only runs when a bucket is selected
  // -------------------------------------------------------------------------

  const objectsQuery = useQuery({
    queryKey: ["storage-objects", selectedBucket, currentPrefix],
    enabled: selectedBucket !== null,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        prefix: currentPrefix,
        delimiter: "/",
        maxKeys: "1000",
      });
      return client.get<{ data: ListObjectsResult }>(
        `/v1/storage/buckets/${encodeURIComponent(selectedBucket!)}/objects?${params.toString()}`,
        undefined,
        { signal },
      );
    },
  });

  const listResult = objectsQuery.data?.data;
  const allObjects = listResult?.objects ?? [];

  // Apply client-side search filter. Folders are always shown to allow
  // navigation even when a search term is active.
  const filteredObjects = searchQuery
    ? allObjects.filter(
        (o) =>
          o.isFolder ||
          displayName(o.key, currentPrefix).toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : allObjects;

  // -------------------------------------------------------------------------
  // Delete mutation
  // -------------------------------------------------------------------------

  const deleteMutation = useMutation({
    mutationFn: (obj: StorageObject) =>
      client.delete(
        `/v1/storage/buckets/${encodeURIComponent(selectedBucket!)}/objects/${encodeObjectKeyPath(obj.key)}`,
      ),
    onSuccess: (_data, obj) => {
      toast({ title: "Object deleted", description: obj.key });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({
        queryKey: ["storage-objects", selectedBucket, currentPrefix],
      });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Delete failed.";
      toast({ title: "Delete failed", description: message, variant: "destructive" });
    },
  });

  // -------------------------------------------------------------------------
  // Download handler — fetches a pre-signed URL then opens it in a new tab.
  // The pre-signed URL is generated server-side so the browser never sees
  // the storage credentials.
  // -------------------------------------------------------------------------

  async function handleDownload(obj: StorageObject): Promise<void> {
    try {
      const response = await client.get<{ data: { url: string } }>(
        `/v1/storage/buckets/${encodeURIComponent(selectedBucket!)}/download/${encodeObjectKeyPath(obj.key)}`,
      );
      window.open(response.data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to generate download link.";
      toast({ title: "Download failed", description: message, variant: "destructive" });
    }
  }

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------

  function enterFolder(folderKey: string): void {
    // folderKey always ends in "/" — it is the full key of the folder prefix.
    setCurrentPrefix(folderKey);
    setSearchQuery("");
  }

  function navigateToBreadcrumb(prefix: string): void {
    setCurrentPrefix(prefix);
    setSearchQuery("");
  }

  function navigateBackToBuckets(): void {
    setSelectedBucket(null);
    setCurrentPrefix("");
    setSearchQuery("");
  }

  /**
   * Builds breadcrumb segments from the current prefix.
   * "logs/2024/december/" => [{label: "logs", prefix: "logs/"}, {label: "2024", prefix: "logs/2024/"}, ...]
   */
  function buildBreadcrumbs(): Array<{ label: string; prefix: string }> {
    if (!currentPrefix) return [];
    const parts = currentPrefix.split("/").filter(Boolean);
    return parts.map((part, i) => ({
      label: part,
      prefix: parts.slice(0, i + 1).join("/") + "/",
    }));
  }

  const breadcrumbs = buildBreadcrumbs();

  // -------------------------------------------------------------------------
  // Render — bucket selector view
  // -------------------------------------------------------------------------

  if (selectedBucket === null) {
    return (
      <div>
        <PageHeader
          title="Storage Browser"
          description="Browse and manage files stored in MinIO/S3 buckets."
        />

        <div className="mt-6">
          {bucketsQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : bucketsQuery.isError ? (
            <div className="rounded-lg border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/5 p-4 text-sm text-[var(--color-destructive)]">
              Failed to load buckets. Check that MinIO is reachable and your credentials are correct.
            </div>
          ) : buckets.length === 0 ? (
            <EmptyState
              icon={<HardDrive className="h-8 w-8" />}
              title="No buckets found"
              description="No buckets exist in this storage instance."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {buckets.map((bucket) => (
                <button
                  key={bucket.name}
                  type="button"
                  onClick={() => setSelectedBucket(bucket.name)}
                  className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-left transition-colors hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
                >
                  <HardDrive className="h-6 w-6 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{bucket.name}</p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Created <RelativeTime value={bucket.createdAt} />
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render — object browser view (inside a selected bucket)
  // -------------------------------------------------------------------------

  return (
    <div>
      <PageHeader
        title={selectedBucket}
        description="Browse objects, download files, or delete objects."
        actions={
          <Button variant="outline" size="sm" onClick={navigateBackToBuckets}>
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            All buckets
          </Button>
        }
      />

      <div className="mt-4 px-6">
        {/* Breadcrumb navigation */}
        <nav aria-label="Object prefix navigation" className="mb-4">
          <ol role="list" className="flex flex-wrap items-center gap-1 text-sm">
            <li>
              <button
                type="button"
                onClick={() => navigateToBreadcrumb("")}
                className="text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] rounded-sm"
              >
                {selectedBucket}
              </button>
            </li>
            {breadcrumbs.map((crumb, i) => (
              <li key={crumb.prefix} className="flex items-center gap-1">
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
                {i < breadcrumbs.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => navigateToBreadcrumb(crumb.prefix)}
                    className="text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] rounded-sm"
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span className="font-medium text-[var(--color-foreground)]" aria-current="location">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>

        {/* Search filter */}
        <div className="mb-4 flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
              aria-hidden="true"
            />
            <Input
              placeholder="Filter by filename..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              aria-label="Filter objects by filename"
            />
          </div>
        </div>

        {/* Object table */}
        {objectsQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : objectsQuery.isError ? (
          <div className="rounded-lg border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/5 p-4 text-sm text-[var(--color-destructive)]">
            Failed to list objects. The bucket may not exist or you may not have permission.
          </div>
        ) : filteredObjects.length === 0 ? (
          <EmptyState
            icon={searchQuery ? <Search className="h-8 w-8" /> : <Folder className="h-8 w-8" />}
            title={searchQuery ? "No objects match" : "This location is empty"}
            description={
              searchQuery
                ? `No objects match "${searchQuery}". Try a different search term.`
                : "There are no objects at this prefix."
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/2">Name</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Last modified</TableHead>
                <TableHead>Content type</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredObjects.map((obj) => (
                <ObjectRow
                  key={obj.key}
                  object={obj}
                  currentPrefix={currentPrefix}
                  onEnterFolder={enterFolder}
                  onDownload={handleDownload}
                  onDelete={setDeleteTarget}
                />
              ))}
            </TableBody>
          </Table>
        )}

        {/* Pagination notice when result is truncated */}
        {listResult?.isTruncated === true && (
          <p className="mt-3 text-center text-xs text-[var(--color-muted-foreground)]">
            Results are truncated. Use a more specific prefix to see more objects.
          </p>
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete object"
        description={
          deleteTarget !== null
            ? `Permanently delete "${displayName(deleteTarget.key, currentPrefix)}"? This action cannot be undone.`
            : ""
        }
        confirmLabel="Delete object"
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget);
        }}
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ObjectRow — renders a single table row for a folder or file object.
// ---------------------------------------------------------------------------

interface ObjectRowProps {
  object: StorageObject;
  currentPrefix: string;
  onEnterFolder: (key: string) => void;
  onDownload: (obj: StorageObject) => Promise<void>;
  onDelete: (obj: StorageObject) => void;
}

function ObjectRow({
  object,
  currentPrefix,
  onEnterFolder,
  onDownload,
  onDelete,
}: ObjectRowProps) {
  const name = displayName(object.key, currentPrefix);
  const [downloading, setDownloading] = React.useState(false);

  async function handleDownloadClick(): Promise<void> {
    setDownloading(true);
    try {
      await onDownload(object);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          {object.isFolder ? (
            <Folder className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
          ) : (
            <File className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
          )}
          {object.isFolder ? (
            <button
              type="button"
              onClick={() => onEnterFolder(object.key)}
              className="truncate font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] rounded-sm"
            >
              {name}
            </button>
          ) : (
            <span className="truncate font-medium">{name}</span>
          )}
        </div>
      </TableCell>
      <TableCell className="tabular-nums text-sm text-[var(--color-muted-foreground)]">
        {object.size !== null ? formatBytes(object.size) : "—"}
      </TableCell>
      <TableCell className="text-sm text-[var(--color-muted-foreground)]">
        {object.lastModified !== null ? (
          <RelativeTime value={object.lastModified} />
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="font-mono text-xs text-[var(--color-muted-foreground)]">
        {object.contentType ?? "—"}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {!object.isFolder && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void handleDownloadClick()}
                disabled={downloading}
                aria-label={`Download "${name}"`}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-[var(--color-destructive)]"
                onClick={() => onDelete(object)}
                aria-label={`Delete "${name}"`}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// EmptyState — reusable empty state card
// ---------------------------------------------------------------------------

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-16 text-center">
      <div className="mb-4 text-[var(--color-muted-foreground)]">{icon}</div>
      <p className="mb-1 font-medium">{title}</p>
      <p className="max-w-sm text-sm text-[var(--color-muted-foreground)]">{description}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Encode an object key for inclusion in a URL path.
// Slashes that are structural path separators are preserved; only individual
// key segments are percent-encoded.
// ---------------------------------------------------------------------------

function encodeObjectKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
