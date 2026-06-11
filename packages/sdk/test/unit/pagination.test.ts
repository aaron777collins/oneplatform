/**
 * Unit tests for the Paginator.
 * Covers: AsyncIterable protocol, collect(), take(), firstPage(), PaginationLimitError.
 */

import { describe, it, expect, vi } from 'vitest';
import { Paginator } from '../../src/pagination/paginator.js';
import { PaginationLimitError } from '../../src/errors/client-errors.js';
import type { Page } from '../../src/types/pagination.js';

function makeFetcher<T>(pages: Array<T[]>) {
  let pageIndex = 0;
  return vi.fn(async (_cursor: string | null, _limit: number): Promise<Page<T>> => {
    const items = pages[pageIndex] ?? [];
    const isLast = pageIndex >= pages.length - 1;
    pageIndex++;
    return {
      items,
      nextCursor: isLast ? null : `cursor_${pageIndex}`,
      total: pages.reduce((acc, p) => acc + p.length, 0),
      hasMore: !isLast,
    };
  });
}

describe('Paginator async iteration', () => {
  it('iterates all pages and stops at null cursor', async () => {
    const fetcher = makeFetcher([[1, 2], [3, 4], [5]]);
    const paginator = new Paginator(fetcher, 2);
    const pages: number[][] = [];

    for await (const page of paginator) {
      pages.push(page.items);
    }

    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('handles empty collection', async () => {
    const fetcher = makeFetcher([[]]);
    const paginator = new Paginator(fetcher);
    const pages = [];
    for await (const page of paginator) {
      pages.push(page);
    }
    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toHaveLength(0);
  });
});

describe('Paginator.collect()', () => {
  it('collects all items into a flat array', async () => {
    const fetcher = makeFetcher([[1, 2], [3, 4], [5]]);
    const paginator = new Paginator(fetcher);
    const result = await paginator.collect();
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('throws PaginationLimitError when exceeding maxItems with more pages', async () => {
    // Each page has 10 items, 3 pages = 30 total; limit of 15 should error
    const fetcher = makeFetcher([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      [21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    ]);
    const paginator = new Paginator(fetcher, 10);

    await expect(paginator.collect(15)).rejects.toBeInstanceOf(PaginationLimitError);
  });

  it('does not throw when collection is exactly at maxItems', async () => {
    const fetcher = makeFetcher([[1, 2, 3]]);
    const paginator = new Paginator(fetcher);
    const result = await paginator.collect(3);
    expect(result).toHaveLength(3);
  });
});

describe('Paginator.take()', () => {
  it('stops early once n items are collected', async () => {
    const fetcher = makeFetcher([[1, 2, 3, 4, 5], [6, 7, 8]]);
    const paginator = new Paginator(fetcher, 5);
    const result = await paginator.take(3);
    expect(result).toEqual([1, 2, 3]);
  });

  it('returns all items if collection is smaller than n', async () => {
    const fetcher = makeFetcher([[1, 2]]);
    const paginator = new Paginator(fetcher);
    const result = await paginator.take(10);
    expect(result).toEqual([1, 2]);
  });
});

describe('Paginator.firstPage()', () => {
  it('returns first page without iterating further', async () => {
    const fetcher = makeFetcher([[1, 2, 3], [4, 5]]);
    const paginator = new Paginator(fetcher);
    const page = await paginator.firstPage();
    expect(page.items).toEqual([1, 2, 3]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns synthetic empty page for empty collection', async () => {
    const fetcher = vi.fn(async () => ({
      items: [],
      nextCursor: null as string | null,
      total: 0 as number | null,
      hasMore: false,
    }));
    const paginator = new Paginator(fetcher);
    const page = await paginator.firstPage();
    expect(page.items).toHaveLength(0);
    expect(page.hasMore).toBe(false);
  });
});
