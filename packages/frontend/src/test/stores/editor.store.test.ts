import { describe, it, expect, afterEach } from "vitest";
import { useEditorStore } from "@/stores/editor.store";

// ---------------------------------------------------------------------------
// Reset the singleton via the store's own reset action between tests.
// reset() zeroes out the Map reference so each test gets a fresh Map instance.
// ---------------------------------------------------------------------------

afterEach(() => {
  useEditorStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openFile(
  path: string,
  content = "// content",
  fileVersion = 1,
): void {
  useEditorStore.getState().openFile(path, content, fileVersion);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useEditorStore", () => {
  describe("initial state", () => {
    it("appId is null", () => {
      expect(useEditorStore.getState().appId).toBeNull();
    });

    it("openFiles is an empty Map", () => {
      const { openFiles } = useEditorStore.getState();
      expect(openFiles).toBeInstanceOf(Map);
      expect(openFiles.size).toBe(0);
    });

    it("activeFilePath is null", () => {
      expect(useEditorStore.getState().activeFilePath).toBeNull();
    });

    it('buildStatus is "idle"', () => {
      expect(useEditorStore.getState().buildStatus).toBe("idle");
    });

    it("lastBuildId is null", () => {
      expect(useEditorStore.getState().lastBuildId).toBeNull();
    });
  });

  describe("openFile", () => {
    it("adds file to the map and makes it active", () => {
      openFile("/app/main.ts", "const x = 1;", 3);

      const state = useEditorStore.getState();
      expect(state.openFiles.has("/app/main.ts")).toBe(true);
      expect(state.activeFilePath).toBe("/app/main.ts");
    });

    it("stores file with isDirty=false, correct content, and fileVersion", () => {
      openFile("/app/main.ts", "const x = 1;", 3);

      const file = useEditorStore.getState().openFiles.get("/app/main.ts")!;
      expect(file.isDirty).toBe(false);
      expect(file.content).toBe("const x = 1;");
      expect(file.fileVersion).toBe(3);
    });

    it("second opened file becomes active while first remains in map", () => {
      openFile("/app/a.ts");
      openFile("/app/b.ts");

      const state = useEditorStore.getState();
      expect(state.activeFilePath).toBe("/app/b.ts");
      expect(state.openFiles.has("/app/a.ts")).toBe(true);
    });

    it("opening an already-open file does NOT overwrite dirty in-memory content", () => {
      openFile("/app/main.ts", "original");
      // Simulate user edits
      useEditorStore.getState().markDirty("/app/main.ts", "dirty edit");

      // Re-open same path with different server content
      openFile("/app/main.ts", "server content", 99);

      const file = useEditorStore.getState().openFiles.get("/app/main.ts")!;
      // Dirty content must be preserved — the server version must be ignored
      expect(file.content).toBe("dirty edit");
      expect(file.isDirty).toBe(true);
    });

    it("opening an already-open file sets it as activeFilePath", () => {
      openFile("/app/main.ts");
      openFile("/app/other.ts");
      // Now main.ts is not active; re-opening it should make it active
      openFile("/app/main.ts");

      expect(useEditorStore.getState().activeFilePath).toBe("/app/main.ts");
    });
  });

  describe("closeFile", () => {
    it("closing the active file activates the next remaining file", () => {
      openFile("/app/a.ts");
      openFile("/app/b.ts"); // b.ts is now active

      useEditorStore.getState().closeFile("/app/b.ts");

      // After closing b.ts, a.ts should become active
      expect(useEditorStore.getState().activeFilePath).toBe("/app/a.ts");
    });

    it("closing the only open file sets activeFilePath to null", () => {
      openFile("/app/only.ts");
      useEditorStore.getState().closeFile("/app/only.ts");

      expect(useEditorStore.getState().activeFilePath).toBeNull();
    });

    it("closing a non-active file leaves activeFilePath unchanged", () => {
      openFile("/app/a.ts");
      openFile("/app/b.ts"); // b.ts is active

      useEditorStore.getState().closeFile("/app/a.ts");

      expect(useEditorStore.getState().activeFilePath).toBe("/app/b.ts");
    });

    it("closed file is removed from openFiles map", () => {
      openFile("/app/a.ts");
      openFile("/app/b.ts");

      useEditorStore.getState().closeFile("/app/a.ts");

      expect(useEditorStore.getState().openFiles.has("/app/a.ts")).toBe(false);
    });
  });

  describe("markDirty", () => {
    it("marks file dirty and updates in-memory content", () => {
      openFile("/app/main.ts", "original", 1);
      useEditorStore.getState().markDirty("/app/main.ts", "updated content");

      const file = useEditorStore.getState().openFiles.get("/app/main.ts")!;
      expect(file.isDirty).toBe(true);
      expect(file.content).toBe("updated content");
    });

    it("is a no-op for a path that is not open (must not throw)", () => {
      // Calling markDirty on an unknown path must be silent
      expect(() => {
        useEditorStore.getState().markDirty("/app/ghost.ts", "content");
      }).not.toThrow();
    });
  });

  describe("markSaved", () => {
    it("clears isDirty and updates fileVersion after a successful save", () => {
      openFile("/app/main.ts", "original", 1);
      useEditorStore.getState().markDirty("/app/main.ts", "dirty");
      useEditorStore.getState().markSaved("/app/main.ts", 2);

      const file = useEditorStore.getState().openFiles.get("/app/main.ts")!;
      expect(file.isDirty).toBe(false);
      expect(file.fileVersion).toBe(2);
    });

    it("is a no-op for a path that is not open (must not throw)", () => {
      expect(() => {
        useEditorStore.getState().markSaved("/app/ghost.ts", 5);
      }).not.toThrow();
    });
  });

  describe("setActiveFile", () => {
    it("switches activeFilePath to the specified file", () => {
      openFile("/app/a.ts");
      openFile("/app/b.ts"); // b.ts is active

      useEditorStore.getState().setActiveFile("/app/a.ts");

      expect(useEditorStore.getState().activeFilePath).toBe("/app/a.ts");
    });
  });

  describe("setBuildStatus", () => {
    it('sets buildStatus to "building" and updates lastBuildId', () => {
      useEditorStore.getState().setBuildStatus("building", "build-1");

      const state = useEditorStore.getState();
      expect(state.buildStatus).toBe("building");
      expect(state.lastBuildId).toBe("build-1");
    });

    it("omitting buildId leaves lastBuildId unchanged from previous value", () => {
      useEditorStore.getState().setBuildStatus("building", "build-1");
      // Transition to idle without providing a new buildId
      useEditorStore.getState().setBuildStatus("idle");

      const state = useEditorStore.getState();
      expect(state.buildStatus).toBe("idle");
      // The previous build id must be retained for reference
      expect(state.lastBuildId).toBe("build-1");
    });

    it('sets buildStatus to "success" and updates lastBuildId', () => {
      useEditorStore.getState().setBuildStatus("success", "build-2");

      const state = useEditorStore.getState();
      expect(state.buildStatus).toBe("success");
      expect(state.lastBuildId).toBe("build-2");
    });
  });

  describe("reset", () => {
    it("clears appId, all open files, and build state", () => {
      useEditorStore.getState().setAppId("app-123");
      openFile("/app/a.ts");
      openFile("/app/b.ts");
      useEditorStore.getState().setBuildStatus("success", "build-9");

      useEditorStore.getState().reset();

      const state = useEditorStore.getState();
      expect(state.appId).toBeNull();
      expect(state.activeFilePath).toBeNull();
      expect(state.buildStatus).toBe("idle");
      expect(state.lastBuildId).toBeNull();
    });

    it("openFiles is an empty Map after reset", () => {
      openFile("/app/a.ts");
      openFile("/app/b.ts");

      useEditorStore.getState().reset();

      const { openFiles } = useEditorStore.getState();
      expect(openFiles).toBeInstanceOf(Map);
      expect(openFiles.size).toBe(0);
    });

    it("activeFilePath is null after reset", () => {
      openFile("/app/a.ts");
      useEditorStore.getState().reset();
      expect(useEditorStore.getState().activeFilePath).toBeNull();
    });
  });
});
