/**
 * NodePalette — side panel listing available step types.
 *
 * The user drags a step type from the palette onto the canvas to add a new
 * node. We use the HTML Drag-and-Drop API with a custom data transfer payload
 * so the canvas knows which type to instantiate on drop.
 *
 * Each palette item is also keyboard-accessible: pressing Enter or Space on
 * a focused item fires the onAdd callback so mouse-free users can add steps.
 */
import * as React from "react";
import {
  Code2,
  Plug,
  ArrowLeftRight,
  GitBranch,
  Layers,
  Clock,
  CheckSquare,
  Workflow,
  Webhook,
  Search,
  type LucideProps,
} from "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/lib/utils.js";
import type { GraphStepType } from "./graph-model.js";

// ---------------------------------------------------------------------------
// Palette item metadata
// ---------------------------------------------------------------------------

type IconComponent = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

interface PaletteItem {
  type: GraphStepType;
  label: string;
  description: string;
  icon: IconComponent;
  /** Tailwind color class for the icon */
  iconClass: string;
}

const PALETTE_ITEMS: PaletteItem[] = [
  {
    type: "code",
    label: "Code",
    description: "Execute JS/TS/Python/Go in sandbox",
    icon: Code2,
    iconClass: "text-blue-500",
  },
  {
    type: "connector",
    label: "Connector",
    description: "Trigger a connector sync",
    icon: Plug,
    iconClass: "text-cyan-500",
  },
  {
    type: "transformer",
    label: "Transformer",
    description: "Apply a transformer plugin",
    icon: ArrowLeftRight,
    iconClass: "text-teal-500",
  },
  {
    type: "transform",
    label: "Transform",
    description: "Declarative data transformation",
    icon: ArrowLeftRight,
    iconClass: "text-green-500",
  },
  {
    type: "conditional",
    label: "Conditional",
    description: "Branch on field value",
    icon: GitBranch,
    iconClass: "text-yellow-500",
  },
  {
    type: "parallel",
    label: "Parallel",
    description: "Run branches concurrently",
    icon: Layers,
    iconClass: "text-violet-500",
  },
  {
    type: "webhook",
    label: "Webhook",
    description: "Outbound HTTP request",
    icon: Webhook,
    iconClass: "text-pink-500",
  },
  {
    type: "wait",
    label: "Wait",
    description: "Pause for a fixed duration",
    icon: Clock,
    iconClass: "text-gray-500",
  },
  {
    type: "approval",
    label: "Approval",
    description: "Pause until approver responds",
    icon: CheckSquare,
    iconClass: "text-orange-500",
  },
  {
    type: "sub_workflow",
    label: "Sub-workflow",
    description: "Invoke another pipeline",
    icon: Workflow,
    iconClass: "text-purple-500",
  },
];

// The drag-and-drop data key used to communicate the step type to the canvas.
export const PALETTE_DRAG_TYPE_KEY = "application/oneplatform-step-type";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NodePaletteProps {
  /**
   * Called when a palette item is "added" via keyboard (Enter/Space).
   * The canvas handles drop events itself; this callback is for keyboard users.
   */
  onAdd: (type: GraphStepType) => void;
}

// ---------------------------------------------------------------------------
// NodePalette component
// ---------------------------------------------------------------------------

export function NodePalette({ onAdd }: NodePaletteProps) {
  const [search, setSearch] = React.useState("");

  const filtered =
    search.trim().length === 0
      ? PALETTE_ITEMS
      : PALETTE_ITEMS.filter(
          (item) =>
            item.label.toLowerCase().includes(search.toLowerCase()) ||
            item.description.toLowerCase().includes(search.toLowerCase())
        );

  return (
    <aside
      className="flex h-full w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-card)]"
      aria-label="Step palette"
    >
      {/* Header */}
      <div className="border-b border-[var(--color-border)] px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
          Steps
        </h2>
      </div>

      {/* Search */}
      <div className="relative px-2 py-2">
        <Search
          className="absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted-foreground)]"
          aria-hidden
        />
        <Input
          className="h-7 pl-7 text-xs"
          placeholder="Filter steps…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Filter step types"
        />
      </div>

      {/* Item list */}
      <ul className="flex-1 overflow-y-auto px-2 pb-4 space-y-1" role="list">
        {filtered.length === 0 ? (
          <li className="px-2 py-6 text-center text-xs text-[var(--color-muted-foreground)]">
            No matching steps
          </li>
        ) : (
          filtered.map((item) => (
            <PaletteItem key={item.type} item={item} onAdd={onAdd} />
          ))
        )}
      </ul>

      <p className="border-t border-[var(--color-border)] px-3 py-2 text-[10px] text-[var(--color-muted-foreground)]">
        Drag onto canvas or press Enter to add
      </p>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// PaletteItem
// ---------------------------------------------------------------------------

interface PaletteItemProps {
  item: PaletteItem;
  onAdd: (type: GraphStepType) => void;
}

function PaletteItem({ item, onAdd }: PaletteItemProps) {
  const Icon = item.icon;

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData(PALETTE_DRAG_TYPE_KEY, item.type);
    e.dataTransfer.effectAllowed = "copy";
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onAdd(item.type);
    }
  }

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        draggable
        aria-label={`Add ${item.label} step`}
        className={cn(
          "flex cursor-grab items-start gap-2 rounded-md px-2 py-2",
          "border border-transparent transition-colors",
          "hover:bg-[var(--color-muted)] hover:border-[var(--color-border)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]",
          "active:cursor-grabbing"
        )}
        onDragStart={handleDragStart}
        onClick={() => onAdd(item.type)}
        onKeyDown={handleKeyDown}
      >
        <div className="mt-0.5 shrink-0">
          <Icon className={cn("h-4 w-4", item.iconClass)} aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--color-foreground)]">
            {item.label}
          </p>
          <p className="text-[10px] text-[var(--color-muted-foreground)] leading-tight mt-0.5">
            {item.description}
          </p>
        </div>
      </div>
    </li>
  );
}
