// Pure line-diff implementation — no external dependencies.
//
// The algorithm is a simplified Myers diff (linear-space variant) using the
// classic LCS (longest common subsequence) approach via a DP table. This is
// sufficient for the code-file sizes in the VFS (≤1MB per file, typically
// a few hundred lines). For the scale of app builder usage this is fast enough
// without pulling in a library.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DiffOperation = "equal" | "insert" | "delete";

export interface LineDiff {
  operation: DiffOperation;
  lineNumber: number;  // 1-based line number in the "new" file (insert/equal) or "old" file (delete)
  content:    string;
}

export interface FileDiff {
  path:     string;
  hunks:    DiffHunk[];
  // Convenience counts
  additions: number;
  deletions: number;
}

// A hunk is a contiguous block of changes (the unified-diff concept).
// context lines (equal) before and after the changed lines are included.
export interface DiffHunk {
  oldStart:   number;  // 1-based line number in old file
  oldLines:   number;  // count of lines from old file in this hunk
  newStart:   number;  // 1-based line number in new file
  newLines:   number;  // count of lines from new file in this hunk
  lines:      LineDiff[];
}

export interface SnapshotDiff {
  added:    string[];           // file paths only in newFiles
  removed:  string[];           // file paths only in oldFiles
  modified: FileDiff[];         // files present in both with changes
  // Files present in both that are byte-for-byte identical are omitted.
}

// ---------------------------------------------------------------------------
// Internal LCS / edit-script
// ---------------------------------------------------------------------------

// Returns the edit script as an array of LineDiff operations in order.
// This is an O(m*n) DP table LCS approach — acceptable for files ≤ a few
// thousand lines in an app-builder context.
function computeLineDiffs(oldLines: string[], newLines: string[]): LineDiff[] {
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = length of LCS of oldLines[0..i-1] and newLines[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Traceback: walk the DP table to reconstruct the edit sequence
  const diffs: LineDiff[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffs.push({ operation: "equal", lineNumber: j, content: newLines[j - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      diffs.push({ operation: "insert", lineNumber: j, content: newLines[j - 1]! });
      j--;
    } else {
      diffs.push({ operation: "delete", lineNumber: i, content: oldLines[i - 1]! });
      i--;
    }
  }

  // Traceback produces reverse order
  diffs.reverse();
  return diffs;
}

// ---------------------------------------------------------------------------
// Hunk grouping — unified-diff style with 3 lines of context
// ---------------------------------------------------------------------------

const CONTEXT_LINES = 3;

function groupIntoHunks(diffs: LineDiff[], oldLines: string[], newLines: string[]): DiffHunk[] {
  // Find indices of changed lines
  const changedIndices: number[] = [];
  for (let idx = 0; idx < diffs.length; idx++) {
    if (diffs[idx]!.operation !== "equal") {
      changedIndices.push(idx);
    }
  }

  if (changedIndices.length === 0) {
    return [];
  }

  // Build ranges [start, end] in the diffs array that each hunk covers,
  // expanding by CONTEXT_LINES on each side.
  const ranges: Array<[number, number]> = [];
  let rangeStart = Math.max(0, changedIndices[0]! - CONTEXT_LINES);
  let rangeEnd   = Math.min(diffs.length - 1, changedIndices[0]! + CONTEXT_LINES);

  for (let k = 1; k < changedIndices.length; k++) {
    const expandedStart = Math.max(0, changedIndices[k]! - CONTEXT_LINES);
    if (expandedStart <= rangeEnd + 1) {
      // Overlapping or adjacent — extend current range
      rangeEnd = Math.min(diffs.length - 1, changedIndices[k]! + CONTEXT_LINES);
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = expandedStart;
      rangeEnd   = Math.min(diffs.length - 1, changedIndices[k]! + CONTEXT_LINES);
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  // Map each range to a DiffHunk with correct old/new line numbering.
  // We need to determine oldStart/newStart for each hunk — this requires
  // counting how many old/new lines preceded this range.
  const hunks: DiffHunk[] = [];

  for (const [start, end] of ranges) {
    // Count old-file lines consumed before this hunk's start position
    let oldLinesBefore = 0;
    let newLinesBefore = 0;
    for (let idx = 0; idx < start; idx++) {
      const op = diffs[idx]!.operation;
      if (op === "equal" || op === "delete") oldLinesBefore++;
      if (op === "equal" || op === "insert") newLinesBefore++;
    }

    const hunkLines: LineDiff[] = [];
    let oldLinesInHunk = 0;
    let newLinesInHunk = 0;
    let localOld = oldLinesBefore + 1;  // 1-based
    let localNew = newLinesBefore + 1;  // 1-based

    for (let idx = start; idx <= end; idx++) {
      const diff = diffs[idx]!;
      if (diff.operation === "equal") {
        hunkLines.push({ operation: "equal", lineNumber: localNew, content: diff.content });
        oldLinesInHunk++;
        newLinesInHunk++;
        localOld++;
        localNew++;
      } else if (diff.operation === "delete") {
        hunkLines.push({ operation: "delete", lineNumber: localOld, content: diff.content });
        oldLinesInHunk++;
        localOld++;
      } else {
        hunkLines.push({ operation: "insert", lineNumber: localNew, content: diff.content });
        newLinesInHunk++;
        localNew++;
      }
    }

    hunks.push({
      oldStart:  oldLinesBefore + 1,
      oldLines:  oldLinesInHunk,
      newStart:  newLinesBefore + 1,
      newLines:  newLinesInHunk,
      lines:     hunkLines,
    });
  }

  // Suppress unused variable warning — oldLines/newLines are used for validation
  void oldLines;
  void newLines;

  return hunks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Computes line-level diff between two versions of a single file.
// Returns null when the files are identical (no diff to show).
export function diffFile(
  path: string,
  oldContent: string,
  newContent: string
): FileDiff | null {
  if (oldContent === newContent) {
    return null;
  }

  // Normalise line endings to \n so diffs are consistent regardless of OS.
  // An empty string splits to [""] (one phantom empty line) — collapse that
  // to [] so empty-file comparisons produce clean addition-only or
  // deletion-only diffs rather than spurious delete/insert of an empty line.
  const splitLines = (s: string): string[] => {
    const parts = s.replace(/\r\n/g, "\n").split("\n");
    if (parts.length === 1 && parts[0] === "") return [];
    return parts;
  };

  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  const lineDiffs = computeLineDiffs(oldLines, newLines);
  const hunks     = groupIntoHunks(lineDiffs, oldLines, newLines);

  let additions = 0;
  let deletions = 0;
  for (const diff of lineDiffs) {
    if (diff.operation === "insert") additions++;
    else if (diff.operation === "delete") deletions++;
  }

  return { path, hunks, additions, deletions };
}

// Computes the full diff between two VFS snapshots.
// Returns a SnapshotDiff describing which files were added, removed, or modified.
export function computeDiff(
  oldFiles: Record<string, string>,
  newFiles: Record<string, string>
): SnapshotDiff {
  const oldPaths = new Set(Object.keys(oldFiles));
  const newPaths = new Set(Object.keys(newFiles));

  const added:    string[]   = [];
  const removed:  string[]   = [];
  const modified: FileDiff[] = [];

  for (const path of newPaths) {
    if (!oldPaths.has(path)) {
      added.push(path);
    }
  }

  for (const path of oldPaths) {
    if (!newPaths.has(path)) {
      removed.push(path);
    }
  }

  for (const path of oldPaths) {
    if (!newPaths.has(path)) continue;  // already in removed
    const fileDiff = diffFile(path, oldFiles[path]!, newFiles[path]!);
    if (fileDiff !== null) {
      modified.push(fileDiff);
    }
  }

  // Sort for deterministic output
  added.sort();
  removed.sort();
  modified.sort((a, b) => a.path.localeCompare(b.path));

  return { added, removed, modified };
}
