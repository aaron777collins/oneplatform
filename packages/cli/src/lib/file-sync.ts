/**
 * Bidirectional file sync for 'op app dev'.
 * Local changes are debounced and sent to the platform via PUT.
 * Remote changes arrive via SSE and are written to disk.
 * Conflict resolution prompts the user unless --prefer-local or --prefer-remote is set.
 */
import { watch, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { HttpClient } from "./http-client.js";

export type ConflictResolution = "prompt" | "prefer-local" | "prefer-remote";

export interface FileSyncOptions {
  slug: string;
  localDir: string;
  http: HttpClient;
  conflictResolution: ConflictResolution;
  onStatus: (message: string) => void;
}

function debouncedQueue(
  fn: (filePath: string) => Promise<void>,
  ms: number,
): (filePath: string) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();
  return (filePath: string): void => {
    pending.add(filePath);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const batch = [...pending];
      pending.clear();
      for (const p of batch) {
        fn(p);
      }
    }, ms);
  };
}

/**
 * Starts the local file watcher.
 * Returns a cleanup function that stops the watcher.
 */
export function startLocalWatcher(opts: FileSyncOptions): () => void {
  const { slug, localDir, http, onStatus } = opts;

  const uploadFile = debouncedQueue(async (filePath: string): Promise<void> => {
    const relativePath = relative(localDir, filePath).replace(/\\/g, "/");
    try {
      const content = readFileSync(filePath, "utf8");
      await http.put(`/api/v1/apps/${encodeURIComponent(slug)}/files/${encodeURIComponent(relativePath)}`, {
        content,
      });
      onStatus(`Synced: ${relativePath}`);
    } catch {
      onStatus(`Sync failed: ${relativePath}`);
    }
  }, 300);

  const watcher = watch(localDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const fullPath = join(localDir, filename);
    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      uploadFile(fullPath);
    }
  });

  return () => watcher.close();
}

/**
 * Processes a remote file change event from SSE.
 * Writes the remote content to disk if no local conflict, otherwise defers to resolution mode.
 */
export async function applyRemoteChange(
  event: { path: string; content: string; modifiedAt: string },
  localDir: string,
  resolution: ConflictResolution,
  onStatus: (msg: string) => void,
): Promise<void> {
  const localPath = join(localDir, event.path);
  const resolvedPath = resolve(localPath);
  const resolvedDir = resolve(localDir);
  if (!resolvedPath.startsWith(resolvedDir + sep) && resolvedPath !== resolvedDir) {
    throw new Error(`path traversal detected: ${event.path}`);
  }

  if (existsSync(localPath)) {
    const localMtime = statSync(localPath).mtimeMs;
    const remoteMtime = new Date(event.modifiedAt).getTime();

    if (resolution === "prefer-local") {
      // Skip remote change — local wins
      onStatus(`Conflict (kept local): ${event.path}`);
      return;
    }
    if (resolution === "prefer-remote") {
      writeFileSync(localPath, event.content, "utf8");
      onStatus(`Conflict (applied remote): ${event.path}`);
      return;
    }
    // prompt mode — prefer-remote wins in non-TTY for safety
    if (!process.stdin.isTTY || remoteMtime > localMtime) {
      writeFileSync(localPath, event.content, "utf8");
      onStatus(`Conflict (remote newer, applied): ${event.path}`);
    } else {
      onStatus(`Conflict (local newer, kept): ${event.path} — use --prefer-remote to override`);
    }
  } else {
    writeFileSync(localPath, event.content, "utf8");
    onStatus(`Downloaded: ${event.path}`);
  }
}
