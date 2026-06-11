/**
 * Pagination types for cursor-based collection traversal (ADR-29).
 */

export interface Page<T> {
  /** Items on this page. */
  readonly items: T[];

  /** Cursor for the next page. null if this is the last page. */
  readonly nextCursor: string | null;

  /**
   * Total matching items across all pages.
   * null for collections where total computation is too expensive (>100k rows).
   */
  readonly total: number | null;

  /** Whether more pages follow (nextCursor !== null). */
  readonly hasMore: boolean;
}

export interface PaginationOptions {
  /** Page size hint sent to the server. Default: 50. Max: 100. */
  readonly limit?: number;

  /** Starting cursor for resuming a previous pagination session. */
  readonly cursor?: string;
}

/** Raw cursor-paginated response from the server. */
export interface CursorResult<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly total: number | null;
}
