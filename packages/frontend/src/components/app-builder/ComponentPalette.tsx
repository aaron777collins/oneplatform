/**
 * ComponentPalette — left sidebar listing draggable component cards.
 *
 * Components are grouped by category. Each card is a native HTML5 draggable
 * element. When drag starts, `onDragStart` notifies the canvas so it can
 * highlight valid drop targets.
 *
 * The palette is read-only — it never mutates layout state directly.
 */

import * as React from "react";
import {
  Table,
  TrendingUp,
  Badge,
  PanelRight,
  Filter,
  Heading,
  LayoutTemplate,
  Code,
  FileText,
  Search,
} from "lucide-react";
import { PALETTE_ENTRIES, PALETTE_CATEGORIES } from "./palette-registry.js";
import type { PaletteEntry, DragState } from "./types.js";

// ---------------------------------------------------------------------------
// Icon map — maps palette entry icon names to Lucide components
// ---------------------------------------------------------------------------

// Lucide icons carry a complex ref-forwarding type. We cast to a simpler
// signature here because we only use className — the extra Lucide props
// are irrelevant to the palette display.
type SimpleIcon = React.ComponentType<{ className?: string }>;

const ICON_MAP: Record<string, SimpleIcon> = {
  Table: Table as SimpleIcon,
  TrendingUp: TrendingUp as SimpleIcon,
  Badge: Badge as SimpleIcon,
  PanelRight: PanelRight as SimpleIcon,
  Filter: Filter as SimpleIcon,
  Heading: Heading as SimpleIcon,
  LayoutTemplate: LayoutTemplate as SimpleIcon,
  Code: Code as SimpleIcon,
  FileText: FileText as SimpleIcon,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ComponentPaletteProps {
  onDragStart: (drag: DragState) => void;
  onDragEnd: () => void;
}

// ---------------------------------------------------------------------------
// ComponentPalette
// ---------------------------------------------------------------------------

export function ComponentPalette({ onDragStart, onDragEnd }: ComponentPaletteProps) {
  const [search, setSearch] = React.useState("");
  const [expandedCategories, setExpandedCategories] = React.useState<Set<string>>(
    () => new Set(PALETTE_CATEGORIES),
  );

  const filteredEntries = React.useMemo(() => {
    if (search.trim() === "") return PALETTE_ENTRIES;
    const lower = search.toLowerCase();
    return PALETTE_ENTRIES.filter(
      (e) =>
        e.label.toLowerCase().includes(lower) ||
        e.description.toLowerCase().includes(lower) ||
        e.category.toLowerCase().includes(lower),
    );
  }, [search]);

  function toggleCategory(category: string) {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }

  // Group filtered entries by category preserving PALETTE_CATEGORIES order
  const grouped = PALETTE_CATEGORIES.map((cat) => ({
    category: cat,
    entries: filteredEntries.filter((e) => e.category === cat),
  })).filter((g) => g.entries.length > 0);

  return (
    <div className="flex h-full flex-col border-r border-[var(--color-border,#e5e7eb)] bg-[var(--color-muted,#f9fafb)] w-60 shrink-0">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[var(--color-border,#e5e7eb)]">
        <p className="text-xs font-semibold text-[var(--color-muted-foreground,#6b7280)] uppercase tracking-wide mb-2">
          Components
        </p>
        {/* Search */}
        <div className="relative">
          <Search
            className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--color-muted-foreground,#6b7280)]"
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search components"
            className="w-full rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] pl-7 pr-2 py-1 text-xs text-[var(--color-foreground,#111)] placeholder:text-[var(--color-muted-foreground,#9ca3af)] focus:outline-none focus:ring-1 focus:ring-[var(--color-ring,#6366f1)]"
          />
        </div>
      </div>

      {/* Component groups */}
      <div className="flex-1 overflow-y-auto py-2">
        {grouped.length === 0 ? (
          <p className="px-3 py-4 text-xs text-center text-[var(--color-muted-foreground,#6b7280)]">
            No components match your search.
          </p>
        ) : (
          grouped.map(({ category, entries }) => (
            <PaletteGroup
              key={category}
              category={category}
              entries={entries}
              isExpanded={expandedCategories.has(category)}
              onToggle={() => toggleCategory(category)}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>

      {/* Usage hint */}
      <div className="px-3 py-2 border-t border-[var(--color-border,#e5e7eb)]">
        <p className="text-[10px] text-[var(--color-muted-foreground,#6b7280)] text-center">
          Drag components onto the canvas
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaletteGroup — collapsible category section
// ---------------------------------------------------------------------------

interface PaletteGroupProps {
  category: string;
  entries: PaletteEntry[];
  isExpanded: boolean;
  onToggle: () => void;
  onDragStart: (drag: DragState) => void;
  onDragEnd: () => void;
}

function PaletteGroup({
  category,
  entries,
  isExpanded,
  onToggle,
  onDragStart,
  onDragEnd,
}: PaletteGroupProps) {
  return (
    <div className="mb-1">
      {/* Category header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground,#6b7280)] hover:text-[var(--color-foreground,#111)] transition-colors"
        aria-expanded={isExpanded}
      >
        <span>{category}</span>
        <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
      </button>

      {/* Cards */}
      {isExpanded && (
        <div className="px-2 pb-1 space-y-1">
          {entries.map((entry) => (
            <PaletteCard
              key={entry.type}
              entry={entry}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaletteCard — individual draggable component card
// ---------------------------------------------------------------------------

interface PaletteCardProps {
  entry: PaletteEntry;
  onDragStart: (drag: DragState) => void;
  onDragEnd: () => void;
}

function PaletteCard({ entry, onDragStart, onDragEnd }: PaletteCardProps) {
  const Icon = ICON_MAP[entry.icon];

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData(
      "application/x-op-drag",
      JSON.stringify({ source: "palette", paletteType: entry.type }),
    );
    e.dataTransfer.effectAllowed = "copy";
    onDragStart({ source: "palette", paletteType: entry.type });
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      className="flex cursor-grab active:cursor-grabbing items-center gap-2 rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-2 py-1.5 hover:border-[var(--color-primary,#6366f1)]/50 hover:shadow-sm transition-all select-none"
      aria-label={`${entry.label} — ${entry.description}`}
      title={entry.description}
    >
      {Icon !== undefined ? (
        <Icon
          className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground,#6b7280)]"
          aria-hidden="true"
        />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0">
        <p className="text-xs font-medium text-[var(--color-foreground,#111)] truncate">
          {entry.label}
        </p>
      </div>
    </div>
  );
}
