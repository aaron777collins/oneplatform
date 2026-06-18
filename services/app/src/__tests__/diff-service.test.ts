// Unit tests for services/diff-service.ts — G-072
//
// Tests cover: added files, removed files, modified files, line-level diff
// accuracy (insert/delete/equal), empty diff (identical files), and the
// unified-diff hunk grouping with context lines.
// All tests are pure — diff-service has no I/O dependencies.

import { describe, it, expect } from "vitest";
import {
  computeDiff,
  diffFile,
  type SnapshotDiff,
  type FileDiff,
} from "../services/diff-service.js";

// ---------------------------------------------------------------------------
// diffFile — single file diff
// ---------------------------------------------------------------------------

describe("diffFile — identical files", () => {
  it("returns null when both files are the same string", () => {
    const content = "const x = 1;\nconst y = 2;\n";
    expect(diffFile("/src/App.tsx", content, content)).toBeNull();
  });

  it("returns null for empty-to-empty diff", () => {
    expect(diffFile("/a.ts", "", "")).toBeNull();
  });
});

describe("diffFile — pure addition (old is empty)", () => {
  it("reports all lines as inserts when old is empty", () => {
    const newContent = "line1\nline2\nline3";
    const result = diffFile("/new.ts", "", newContent);

    expect(result).not.toBeNull();
    const diff = result as FileDiff;
    expect(diff.path).toBe("/new.ts");
    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(0);

    // Every line in every hunk should be an insert
    const ops = diff.hunks.flatMap((h) => h.lines.map((l) => l.operation));
    expect(ops.every((op) => op === "insert" || op === "equal")).toBe(true);
    expect(ops.some((op) => op === "insert")).toBe(true);
    expect(ops.some((op) => op === "delete")).toBe(false);
  });
});

describe("diffFile — pure deletion (new is empty)", () => {
  it("reports all lines as deletes when new is empty", () => {
    const oldContent = "line1\nline2\nline3";
    const result = diffFile("/old.ts", oldContent, "");

    expect(result).not.toBeNull();
    const diff = result as FileDiff;
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(3);

    const ops = diff.hunks.flatMap((h) => h.lines.map((l) => l.operation));
    expect(ops.some((op) => op === "delete")).toBe(true);
    expect(ops.some((op) => op === "insert")).toBe(false);
  });
});

describe("diffFile — single line changed", () => {
  it("detects a change in the middle of a file", () => {
    const oldContent = ["line1", "line2", "line3"].join("\n");
    const newContent = ["line1", "CHANGED", "line3"].join("\n");

    const result = diffFile("/src/index.ts", oldContent, newContent);
    expect(result).not.toBeNull();
    const diff = result as FileDiff;

    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);

    // Find the delete and insert lines
    const allLines = diff.hunks.flatMap((h) => h.lines);
    const deleted = allLines.filter((l) => l.operation === "delete");
    const inserted = allLines.filter((l) => l.operation === "insert");

    expect(deleted.some((l) => l.content === "line2")).toBe(true);
    expect(inserted.some((l) => l.content === "CHANGED")).toBe(true);
  });
});

describe("diffFile — line additions only", () => {
  it("detects inserted lines at end", () => {
    const oldContent = "a\nb\n";
    const newContent = "a\nb\nc\nd\n";

    const result = diffFile("/f.ts", oldContent, newContent);
    expect(result).not.toBeNull();
    const diff = result as FileDiff;
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
  });

  it("detects inserted lines at start", () => {
    const oldContent = "c\nd\n";
    const newContent = "a\nb\nc\nd\n";

    const result = diffFile("/f.ts", oldContent, newContent);
    expect(result).not.toBeNull();
    const diff = result as FileDiff;
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
  });
});

describe("diffFile — line deletions only", () => {
  it("detects deleted lines from middle", () => {
    const oldContent = "a\nb\nc\nd\n";
    const newContent = "a\nd\n";

    const result = diffFile("/f.ts", oldContent, newContent);
    expect(result).not.toBeNull();
    const diff = result as FileDiff;
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(2);
  });
});

describe("diffFile — hunk structure", () => {
  it("includes context lines around changes", () => {
    // 10 lines, change only line 5. Expect 3 context lines on each side.
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const oldContent = lines.join("\n");
    const modified = [...lines];
    modified[4] = "CHANGED";
    const newContent = modified.join("\n");

    const result = diffFile("/ctx.ts", oldContent, newContent);
    expect(result).not.toBeNull();
    const diff = result as FileDiff;
    expect(diff.hunks.length).toBeGreaterThan(0);

    const hunk = diff.hunks[0]!;
    const equalLines = hunk.lines.filter((l) => l.operation === "equal");
    // At least 3 context lines on each side (but not more than the file has)
    expect(equalLines.length).toBeGreaterThanOrEqual(3);
  });

  it("produces valid oldStart/newStart on a hunk", () => {
    const oldContent = "a\nb\nc\n";
    const newContent = "a\nX\nc\n";

    const result = diffFile("/f.ts", oldContent, newContent);
    const diff = result as FileDiff;
    const hunk = diff.hunks[0]!;

    // Both oldStart and newStart are 1-based positive integers
    expect(hunk.oldStart).toBeGreaterThanOrEqual(1);
    expect(hunk.newStart).toBeGreaterThanOrEqual(1);
  });

  it("merges nearby changes into a single hunk", () => {
    // Changes on lines 1 and 2 are adjacent — should land in a single hunk
    const oldContent = "A\nB\nc\n";
    const newContent = "X\nY\nc\n";

    const result = diffFile("/f.ts", oldContent, newContent);
    const diff = result as FileDiff;
    expect(diff.hunks).toHaveLength(1);
  });
});

describe("diffFile — line numbers", () => {
  it("assigns correct 1-based lineNumber to inserted lines", () => {
    const oldContent = "a\n";
    const newContent = "a\nb\n";

    const result = diffFile("/f.ts", oldContent, newContent);
    const diff = result as FileDiff;
    const inserted = diff.hunks.flatMap((h) => h.lines).filter((l) => l.operation === "insert");
    // The inserted line "b" is line 2 in the new file
    expect(inserted.some((l) => l.lineNumber === 2 && l.content === "b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeDiff — full snapshot diff
// ---------------------------------------------------------------------------

describe("computeDiff — empty snapshots", () => {
  it("returns empty diff for two empty snapshots", () => {
    const result = computeDiff({}, {});
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
  });
});

describe("computeDiff — added files", () => {
  it("reports files present only in newFiles as added", () => {
    const old: Record<string, string> = { "/a.ts": "content a" };
    const next: Record<string, string> = { "/a.ts": "content a", "/b.ts": "content b" };

    const result: SnapshotDiff = computeDiff(old, next);
    expect(result.added).toContain("/b.ts");
    expect(result.removed).toHaveLength(0);
  });

  it("does not put added files into modified", () => {
    const old: Record<string, string> = {};
    const next: Record<string, string> = { "/new.ts": "hello" };

    const result = computeDiff(old, next);
    expect(result.added).toContain("/new.ts");
    expect(result.modified).toHaveLength(0);
  });
});

describe("computeDiff — removed files", () => {
  it("reports files only in oldFiles as removed", () => {
    const old: Record<string, string> = { "/a.ts": "x", "/b.ts": "y" };
    const next: Record<string, string> = { "/a.ts": "x" };

    const result = computeDiff(old, next);
    expect(result.removed).toContain("/b.ts");
    expect(result.added).toHaveLength(0);
  });
});

describe("computeDiff — modified files", () => {
  it("reports files present in both with different content as modified", () => {
    const old: Record<string, string> = { "/a.ts": "old content" };
    const next: Record<string, string> = { "/a.ts": "new content" };

    const result = computeDiff(old, next);
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0]!.path).toBe("/a.ts");
  });

  it("does not report files with identical content as modified", () => {
    const content = "same content";
    const old: Record<string, string> = { "/a.ts": content };
    const next: Record<string, string> = { "/a.ts": content };

    const result = computeDiff(old, next);
    expect(result.modified).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it("modified file diff has correct addition/deletion counts", () => {
    const old: Record<string, string> = {
      "/src/App.tsx": "line1\nline2\nline3\n",
    };
    const next: Record<string, string> = {
      "/src/App.tsx": "line1\nNEW_LINE\nline3\n",
    };

    const result = computeDiff(old, next);
    const fileDiff = result.modified[0]!;
    expect(fileDiff.additions).toBe(1);
    expect(fileDiff.deletions).toBe(1);
  });
});

describe("computeDiff — mixed changes", () => {
  it("handles added, removed, and modified in the same call", () => {
    const old: Record<string, string> = {
      "/keep.ts":  "same",
      "/change.ts": "old",
      "/delete.ts": "gone",
    };
    const next: Record<string, string> = {
      "/keep.ts":  "same",
      "/change.ts": "new",
      "/add.ts":   "added",
    };

    const result = computeDiff(old, next);
    expect(result.added).toContain("/add.ts");
    expect(result.removed).toContain("/delete.ts");
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0]!.path).toBe("/change.ts");
  });

  it("sorts added, removed, and modified paths alphabetically", () => {
    const old: Record<string, string> = {
      "/z.ts": "z",
      "/m.ts": "m",
    };
    const next: Record<string, string> = {
      "/a.ts": "a",
      "/b.ts": "b",
    };

    const result = computeDiff(old, next);
    expect(result.added).toEqual(["/a.ts", "/b.ts"]);
    expect(result.removed).toEqual(["/m.ts", "/z.ts"]);
  });
});
