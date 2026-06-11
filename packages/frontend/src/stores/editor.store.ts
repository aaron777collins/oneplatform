import { create } from "zustand";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenFile {
  path: string;
  content: string;
  isDirty: boolean;
  /** Opaque version token from the server for optimistic locking (§11.4) */
  fileVersion: number;
}

export type BuildStatus = "idle" | "building" | "success" | "failed";

interface EditorState {
  appId: string | null;
  openFiles: Map<string, OpenFile>;
  activeFilePath: string | null;
  buildStatus: BuildStatus;
  lastBuildId: string | null;

  // Actions
  setAppId: (appId: string) => void;
  openFile: (path: string, content: string, fileVersion: number) => void;
  closeFile: (path: string) => void;
  /**
   * Updates in-memory content and marks the file dirty.
   * Called on every Monaco change event — the AppEditor debounces the actual save.
   */
  markDirty: (path: string, content: string) => void;
  /**
   * Updates the stored fileVersion after a successful save.
   * The new fileVersion is needed for the next optimistic locking check.
   */
  markSaved: (path: string, fileVersion: number) => void;
  setActiveFile: (path: string) => void;
  setBuildStatus: (status: BuildStatus, buildId?: string) => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEditorStore = create<EditorState>()((set, get) => ({
  appId: null,
  openFiles: new Map(),
  activeFilePath: null,
  buildStatus: "idle",
  lastBuildId: null,

  setAppId: (appId: string): void => {
    set({ appId });
  },

  openFile: (path: string, content: string, fileVersion: number): void => {
    const { openFiles } = get();
    // If already open, do not overwrite dirty in-memory edits
    if (openFiles.has(path)) {
      set({ activeFilePath: path });
      return;
    }
    const next = new Map(openFiles);
    next.set(path, { path, content, isDirty: false, fileVersion });
    set({ openFiles: next, activeFilePath: path });
  },

  closeFile: (path: string): void => {
    const { openFiles, activeFilePath } = get();
    const next = new Map(openFiles);
    next.delete(path);

    // If closing the active file, activate the most recently opened file
    let newActive: string | null = activeFilePath;
    if (activeFilePath === path) {
      const keys = [...next.keys()];
      const lastKey = keys[keys.length - 1];
      newActive = lastKey ?? null;
    }

    set({ openFiles: next, activeFilePath: newActive });
  },

  markDirty: (path: string, content: string): void => {
    const { openFiles } = get();
    const file = openFiles.get(path);
    if (file === undefined) return;
    const next = new Map(openFiles);
    next.set(path, { ...file, content, isDirty: true });
    set({ openFiles: next });
  },

  markSaved: (path: string, fileVersion: number): void => {
    const { openFiles } = get();
    const file = openFiles.get(path);
    if (file === undefined) return;
    const next = new Map(openFiles);
    next.set(path, { ...file, isDirty: false, fileVersion });
    set({ openFiles: next });
  },

  setActiveFile: (path: string): void => {
    set({ activeFilePath: path });
  },

  setBuildStatus: (status: BuildStatus, buildId?: string): void => {
    set({
      buildStatus: status,
      ...(buildId !== undefined ? { lastBuildId: buildId } : {}),
    });
  },

  reset: (): void => {
    set({
      appId: null,
      openFiles: new Map(),
      activeFilePath: null,
      buildStatus: "idle",
      lastBuildId: null,
    });
  },
}));
