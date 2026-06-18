/**
 * ConnectionLine — SVG bezier path connecting an output port to an input port.
 *
 * We use a cubic bezier whose control points pull horizontally outward from
 * each port. This ensures the curve looks natural regardless of whether the
 * target is to the right, left, or directly above/below the source.
 *
 * The component is intentionally presentation-only: click/hover events are
 * surfaced via callbacks rather than internal state so the parent canvas
 * owns all selection logic.
 */
import * as React from "react";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionLineProps {
  /** Unique ID for the edge (used as SVG element key and aria-label) */
  id: string;
  /** Canvas-space coordinates of the source (output) port centre */
  sourceX: number;
  sourceY: number;
  /** Canvas-space coordinates of the target (input) port centre */
  targetX: number;
  targetY: number;
  /** Optional label shown at the midpoint ('then' | 'else') */
  label?: string;
  /** Whether this edge is currently selected */
  selected?: boolean;
  onClick?: (edgeId: string) => void;
  /** True while the user is dragging a new connection from a port */
  isDragging?: boolean;
}

// ---------------------------------------------------------------------------
// ConnectionLine component
// ---------------------------------------------------------------------------

export function ConnectionLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  selected = false,
  onClick,
  isDragging = false,
}: ConnectionLineProps) {
  const [hovered, setHovered] = React.useState(false);

  // Horizontal control-point offset — scales with distance so short edges
  // still curve noticeably without looking exaggerated on long ones.
  const dx = Math.max(Math.abs(targetX - sourceX) * 0.5, 60);

  const path = [
    `M ${sourceX} ${sourceY}`,
    `C ${sourceX + dx} ${sourceY}, ${targetX - dx} ${targetY}, ${targetX} ${targetY}`,
  ].join(" ");

  // Midpoint for label placement
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;

  const isActive = selected || hovered || isDragging;

  return (
    <g
      role="button"
      aria-label={`Pipeline connection${label !== undefined ? ` (${label})` : ""}`}
      style={{ cursor: onClick !== undefined ? "pointer" : "default" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onClick?.(id)}
    >
      {/* Invisible wider hit area so the user can click a thin line */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        aria-hidden
      />

      {/* Visible path */}
      <path
        d={path}
        fill="none"
        className={cn(
          "transition-all duration-150",
          isActive
            ? "stroke-[var(--color-primary)]"
            : "stroke-[var(--color-border)]"
        )}
        strokeWidth={isActive ? 2.5 : 1.5}
        strokeDasharray={isDragging ? "6 3" : undefined}
        markerEnd="url(#arrowhead)"
      />

      {/* Edge label (then / else) */}
      {label !== undefined && (
        <>
          <rect
            x={midX - 18}
            y={midY - 10}
            width={36}
            height={20}
            rx={4}
            className={cn(
              "fill-[var(--color-card)]",
              isActive
                ? "stroke-[var(--color-primary)]"
                : "stroke-[var(--color-border)]"
            )}
            strokeWidth={1}
          />
          <text
            x={midX}
            y={midY + 4}
            textAnchor="middle"
            className={cn(
              "text-[10px] font-medium select-none",
              isActive
                ? "fill-[var(--color-primary)]"
                : "fill-[var(--color-muted-foreground)]"
            )}
            style={{ fontSize: 10, fontFamily: "inherit" }}
            aria-hidden
          >
            {label}
          </text>
        </>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// SVG defs for the arrowhead marker.
// Rendered once inside the canvas SVG <defs> element.
// ---------------------------------------------------------------------------

export function ArrowheadDef() {
  return (
    <defs>
      <marker
        id="arrowhead"
        markerWidth={8}
        markerHeight={8}
        refX={7}
        refY={3}
        orient="auto"
        markerUnits="userSpaceOnUse"
      >
        <path
          d="M0,0 L0,6 L8,3 z"
          className="fill-[var(--color-border)]"
          style={{ fill: "var(--color-border)" }}
        />
      </marker>
    </defs>
  );
}
