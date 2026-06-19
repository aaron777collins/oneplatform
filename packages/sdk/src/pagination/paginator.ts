/**
 * Cursor-based pagination as AsyncIterable<Page<T>>.
 *
 * The Paginator is the only object that knows when to stop fetching.
 * Resource methods hand it a `fetchPage` closure and return the Paginator
 * to the caller. The caller drives iteration either explicitly (for-await)
 * or via the collect()/take()/firstPage() helpers.
 *
 * The 10,000 item default cap on collect() is a safety net that prevents
 * accidental OOM from naive `await client.data.X.list().collect()` calls
 * on million-row collections.
 */

import type { Page } from '../types/pagination.js';
import { PaginationLimitError } from '../errors/client-errors.js';

/** Fetches a single page given the cursor from the previous page (null = first page). */
export type PageFetcher<T> = (cursor: string | null, limit: number) => Promise<Page<T>>;

/**
 * PaginatedIterable extends AsyncIterable<Page<T>> with convenience helpers.
 * The interface is exported so generated typed clients can declare conformance.
 */
export interface PaginatedIterable<T> extends AsyncIterable<Page<T>> {
  /**
   * Collect all items across all pages into a flat array.
   * Throws PaginationLimitError if more than `maxItems` items exist and there
   * are still pages remaining, preventing unbounded memory use.
   *
   * @param maxItems Hard cap. Default: 10000.
   */
  collect(maxItems?: number): Promise<T[]>;

  /**
   * Collect exactly `n` items, stopping pagination early once collected.
   * Returns fewer items when the total collection is smaller than n.
   */
  take(n: number): Promise<T[]>;

  /** Return the first page without continuing iteration. */
  firstPage(): Promise<Page<T>>;
}

export class Paginator<T> implements PaginatedIterable<T> {
  constructor(
    private readonly fetchPage: PageFetcher<T>,
    private readonly pageSize: number = 50,
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<Page<T>> {
    let cursor: string | null = null;
    do {
      const page = await this.fetchPage(cursor, this.pageSize);
      yield page;
      // Stop when there are no more items, even if the server returns a non-null
      // cursor. Some backends return a cursor with an empty final page; without
      // this guard the loop would fetch empty pages indefinitely.
      if (page.items.length === 0) break;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  async collect(maxItems = 10_000): Promise<T[]> {
    const results: T[] = [];
    for await (const page of this) {
      results.push(...page.items);
      if (results.length >= maxItems) {
        if (page.hasMore) {
          throw new PaginationLimitError(
            `collect() stopped after ${maxItems} items. Pass a higher maxItems or use ` +
              'for-await iteration to process without a memory cap.',
            maxItems,
          );
        }
        break;
      }
    }
    // A single oversized page can push results beyond maxItems — enforce the cap.
    return results.slice(0, maxItems);
  }

  async take(n: number): Promise<T[]> {
    const results: T[] = [];
    for await (const page of this) {
      results.push(...page.items);
      if (results.length >= n) return results.slice(0, n);
    }
    return results;
  }

  async firstPage(): Promise<Page<T>> {
    const iter = this[Symbol.asyncIterator]();
    const result = await iter.next();
    // The generator always yields at least one page (even if empty) before returning
    if (result.done === true || result.value === undefined) {
      // Empty collection — return a synthetic empty page
      return { items: [], nextCursor: null, total: 0, hasMore: false };
    }
    return result.value;
  }
}
