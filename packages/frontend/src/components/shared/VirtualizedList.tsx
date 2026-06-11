/**
 * VirtualizedList — react-window VariableSizeList wrapper for large datasets.
 *
 * Renders only the visible rows in the DOM, enabling smooth scrolling for
 * log viewers and other components with thousands of entries (§15.4).
 *
 * Row heights are measured and cached externally via the provided sizeCache
 * mechanism. When a row's content changes (e.g., expanded state), call
 * resetAfterIndex(index) to invalidate the cached heights below that row.
 */
import * as React from "react";
import { VariableSizeList, type ListChildComponentProps } from "react-window";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VirtualizedListProps<T> {
  /** All items to render. Only visible items are mounted in the DOM. */
  items: T[];
  /** Estimated row height for initial render. Actual heights are measured. */
  estimatedItemSize: number;
  /**
   * Returns the height of the row at the given index.
   * May return the estimated size before measurement.
   */
  itemSize: (index: number) => number;
  /** Renders a single row. The index, style, and data are provided by react-window. */
  renderItem: (props: ListChildComponentProps<T[]>) => React.ReactElement;
  /** Height of the list container in px. Pass "auto" to fill the parent. */
  height: number;
  /** Width of the list container in px or "100%". */
  width: number | string;
  className?: string;
  /**
   * Ref forwarded to the VariableSizeList instance so the parent can call
   * resetAfterIndex() when row content changes.
   */
  listRef?: React.Ref<VariableSizeList<T[]>>;
  /** Scrolls to the bottom of the list when set to "end". */
  scrollToAlignment?: "auto" | "start" | "end" | "center";
  /** If true, automatically scrolls to the last item (tail-follow mode). */
  followTail?: boolean;
}

// ---------------------------------------------------------------------------
// VirtualizedList component
// ---------------------------------------------------------------------------

export function VirtualizedList<T>({
  items,
  estimatedItemSize,
  itemSize,
  renderItem,
  height,
  width,
  className,
  listRef,
  followTail = false,
}: VirtualizedListProps<T>) {
  const internalRef = React.useRef<VariableSizeList<T[]>>(null);

  // Forward the ref to both our internal ref and the caller's ref
  const combinedRef = (instance: VariableSizeList<T[]> | null) => {
    (internalRef as React.MutableRefObject<VariableSizeList<T[]> | null>).current = instance;
    if (typeof listRef === "function") {
      listRef(instance);
    } else if (listRef !== null && listRef !== undefined) {
      (listRef as React.MutableRefObject<VariableSizeList<T[]> | null>).current = instance;
    }
  };

  // Tail-follow: scroll to the last item whenever items change
  React.useEffect(() => {
    if (followTail && items.length > 0) {
      internalRef.current?.scrollToItem(items.length - 1, "end");
    }
  }, [followTail, items.length]);

  return (
    <VariableSizeList<T[]>
      ref={combinedRef}
      height={height}
      width={width}
      itemCount={items.length}
      itemSize={itemSize}
      estimatedItemSize={estimatedItemSize}
      itemData={items}
      className={className}
    >
      {renderItem}
    </VariableSizeList>
  );
}
