/**
 * PipelineNode — a single step rendered on the canvas as a foreign-object
 * HTML card overlaid on the SVG canvas.
 *
 * Using <foreignObject> gives us full CSS styling (Tailwind, border-radius,
 * shadows) without reimplementing layout in SVG. The trade-off is that the
 * element is not purely SVG, but all major browsers support foreignObject in
 * interactive SVGs.
 *
 * Port circles are rendered in SVG space (as sibling elements, not inside the
 * foreignObject) so they sit on the edge of the node card precisely.
 *
 * Keyboard navigation:
 *   - Arrow keys move the node 1 grid unit at a time when focused and selected
 *   - Delete/Backspace removes the node when focused and selected
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
  Repeat2,
  AlertTriangle,
  type LucideProps,
} from "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import { cn } from "@/lib/utils.js";
import {
  type GraphNode,
  type GraphStepType,
  NODE_WIDTH,
  NODE_HEIGHT,
  PORT_RADIUS,
  GRID_SIZE,
} from "./graph-model.js";

// ---------------------------------------------------------------------------
// Step type metadata
// ---------------------------------------------------------------------------

type IconComponent = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

interface StepTypeStyle {
  icon: IconComponent;
  label: string;
  /** Tailwind CSS classes for the node header background and text */
  headerClass: string;
  /** Tailwind border-left accent color class */
  accentClass: string;
}

const STEP_TYPE_STYLES: Record<GraphStepType, StepTypeStyle> = {
  code: {
    icon: Code2,
    label: "Code",
    headerClass: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    accentClass: "border-l-blue-500",
  },
  connector: {
    icon: Plug,
    label: "Connector",
    headerClass: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    accentClass: "border-l-cyan-500",
  },
  transformer: {
    icon: ArrowLeftRight,
    label: "Transformer",
    headerClass: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
    accentClass: "border-l-teal-500",
  },
  transform: {
    icon: ArrowLeftRight,
    label: "Transform",
    headerClass: "bg-green-500/10 text-green-600 dark:text-green-400",
    accentClass: "border-l-green-500",
  },
  conditional: {
    icon: GitBranch,
    label: "Conditional",
    headerClass: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
    accentClass: "border-l-yellow-500",
  },
  parallel: {
    icon: Layers,
    label: "Parallel",
    headerClass: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    accentClass: "border-l-violet-500",
  },
  wait: {
    icon: Clock,
    label: "Wait",
    headerClass: "bg-gray-500/10 text-gray-600 dark:text-gray-400",
    accentClass: "border-l-gray-500",
  },
  approval: {
    icon: CheckSquare,
    label: "Approval",
    headerClass: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    accentClass: "border-l-orange-500",
  },
  sub_workflow: {
    icon: Workflow,
    label: "Sub-workflow",
    headerClass: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
    accentClass: "border-l-purple-500",
  },
  webhook: {
    icon: Webhook,
    label: "Webhook",
    headerClass: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
    accentClass: "border-l-pink-500",
  },
  loop: {
    icon: Repeat2,
    label: "Loop",
    headerClass: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    accentClass: "border-l-indigo-500",
  },
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PipelineNodeProps {
  node: GraphNode;
  selected: boolean;
  onSelect: (nodeId: string) => void;
  onDoubleClick: (nodeId: string) => void;
  onMove: (nodeId: string, dx: number, dy: number) => void;
  onDelete: (nodeId: string) => void;
  /** Called when the user starts dragging from the output port */
  onPortDragStart: (nodeId: string, event: React.MouseEvent) => void;
  /** Called when the user releases a drag onto this node's input port */
  onPortDrop: (nodeId: string) => void;
}

// ---------------------------------------------------------------------------
// PipelineNode component
// ---------------------------------------------------------------------------

export function PipelineNode({
  node,
  selected,
  onSelect,
  onDoubleClick,
  onMove,
  onDelete,
  onPortDragStart,
  onPortDrop,
}: PipelineNodeProps) {
  const style = STEP_TYPE_STYLES[node.type];
  const Icon = style.icon;

  // Input port position (left centre of node)
  const inputPortX = node.position.x;
  const inputPortY = node.position.y + NODE_HEIGHT / 2;
  // Output port position (right centre of node)
  const outputPortX = node.position.x + NODE_WIDTH;
  const outputPortY = node.position.y + NODE_HEIGHT / 2;

  // Confirmation dialog state for deletion
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  function handleDeleteRequest() {
    setConfirmDelete(true);
  }

  function handleDeleteConfirm() {
    setConfirmDelete(false);
    onDelete(node.id);
  }

  // Keyboard-driven movement (arrow keys) and deletion
  function handleKeyDown(e: React.KeyboardEvent) {
    if (!selected) return;

    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        onMove(node.id, GRID_SIZE, 0);
        break;
      case "ArrowLeft":
        e.preventDefault();
        onMove(node.id, -GRID_SIZE, 0);
        break;
      case "ArrowDown":
        e.preventDefault();
        onMove(node.id, 0, GRID_SIZE);
        break;
      case "ArrowUp":
        e.preventDefault();
        onMove(node.id, 0, -GRID_SIZE);
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        handleDeleteRequest();
        break;
    }
  }

  return (
    <g role="group" aria-label={`Pipeline step: ${node.label}`}>
      {/* Input port — invisible touch target (44px diameter) sits behind the visible circle
          to meet the WCAG 2.5.5 minimum touch target size on mobile devices. */}
      <circle
        cx={inputPortX}
        cy={inputPortY}
        r={22}
        fill="transparent"
        stroke="none"
        aria-hidden="true"
        onMouseUp={() => onPortDrop(node.id)}
        onTouchEnd={(e) => {
          e.preventDefault();
          onPortDrop(node.id);
        }}
      />
      {/* Input port — visible circle */}
      <circle
        cx={inputPortX}
        cy={inputPortY}
        r={PORT_RADIUS}
        className={cn(
          "fill-[var(--color-card)] stroke-[var(--color-border)] transition-colors",
          "cursor-crosshair hover:fill-[var(--color-primary)] hover:stroke-[var(--color-primary)]"
        )}
        strokeWidth={2}
        aria-label="Input port"
        onMouseUp={() => onPortDrop(node.id)}
        onTouchEnd={(e) => {
          e.preventDefault();
          onPortDrop(node.id);
        }}
      />

      {/* Output port — invisible touch target */}
      <circle
        cx={outputPortX}
        cy={outputPortY}
        r={22}
        fill="transparent"
        stroke="none"
        aria-hidden="true"
        onMouseDown={(e) => {
          e.stopPropagation();
          onPortDragStart(node.id, e);
        }}
        onTouchStart={(e) => {
          e.stopPropagation();
          // Convert touch to a synthetic MouseEvent so onPortDragStart receives
          // the position data it needs for the pending edge calculation.
          const touch = e.touches[0];
          if (touch !== undefined) {
            onPortDragStart(node.id, {
              clientX: touch.clientX,
              clientY: touch.clientY,
              stopPropagation: () => e.stopPropagation(),
            } as unknown as React.MouseEvent);
          }
        }}
      />
      {/* Output port — visible circle */}
      <circle
        cx={outputPortX}
        cy={outputPortY}
        r={PORT_RADIUS}
        className={cn(
          "fill-[var(--color-card)] stroke-[var(--color-border)] transition-colors",
          "cursor-crosshair hover:fill-[var(--color-primary)] hover:stroke-[var(--color-primary)]"
        )}
        strokeWidth={2}
        aria-label="Output port"
        onMouseDown={(e) => {
          e.stopPropagation(); // prevent canvas pan on port drag
          onPortDragStart(node.id, e);
        }}
        onTouchStart={(e) => {
          e.stopPropagation();
          const touch = e.touches[0];
          if (touch !== undefined) {
            onPortDragStart(node.id, {
              clientX: touch.clientX,
              clientY: touch.clientY,
              stopPropagation: () => e.stopPropagation(),
            } as unknown as React.MouseEvent);
          }
        }}
      />

      {/* Node card via foreignObject */}
      <foreignObject
        x={node.position.x}
        y={node.position.y}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        style={{ overflow: "visible" }}
      >
        <div
          className={cn(
            "h-full w-full rounded-md border border-l-4 bg-[var(--color-card)] shadow-sm",
            "select-none outline-none cursor-grab active:cursor-grabbing",
            "transition-shadow duration-150",
            style.accentClass,
            selected
              ? "ring-2 ring-[var(--color-primary)] shadow-md"
              : "hover:shadow-md"
          )}
          role="button"
          tabIndex={0}
          aria-selected={selected}
          aria-label={`Step: ${node.label} (${style.label})`}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(node.id);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onDoubleClick(node.id);
          }}
          onKeyDown={handleKeyDown}
        >
          {/* Header row */}
          <div
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-t-md",
              style.headerClass
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="text-[10px] font-semibold uppercase tracking-wider truncate">
              {style.label}
            </span>
          </div>

          {/* Label */}
          <div className="px-3 py-1.5">
            <p className="truncate text-sm font-medium text-[var(--color-foreground)]">
              {node.label}
            </p>
          </div>
        </div>
      </foreignObject>

      {/* Delete confirmation overlay */}
      {confirmDelete && (
        <foreignObject
          x={node.position.x - 10}
          y={node.position.y + NODE_HEIGHT + 4}
          width={NODE_WIDTH + 20}
          height={80}
          style={{ overflow: "visible" }}
        >
          <div className="rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-card)] p-2 shadow-lg text-center">
            <div className="flex items-center justify-center gap-1 mb-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-[var(--color-destructive)]" aria-hidden />
              <span className="text-xs font-medium text-[var(--color-destructive)]">Delete this node?</span>
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                className="rounded px-2 py-0.5 text-[10px] font-medium border border-[var(--color-border)] bg-[var(--color-background)] hover:bg-[var(--color-muted)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleDeleteConfirm(); }}
                className="rounded px-2 py-0.5 text-[10px] font-medium bg-[var(--color-destructive)] text-white hover:opacity-90 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </foreignObject>
      )}
    </g>
  );
}
