/**
 * Tests for DataTable component.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";
import { DataTable } from "./data-table.js";
import type { Column } from "./data-table.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  age: number;
}

const USERS: User[] = [
  { id: "1", name: "Alice", email: "alice@example.com", role: "admin", age: 30 },
  { id: "2", name: "Bob", email: "bob@example.com", role: "editor", age: 25 },
  { id: "3", name: "Carol", email: "carol@example.com", role: "viewer", age: 28 },
];

const COLUMNS: Column<User>[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "email", header: "Email" },
  { key: "role", header: "Role" },
  { key: "age", header: "Age", sortable: true },
];

// ---------------------------------------------------------------------------
// Render tests
// ---------------------------------------------------------------------------

describe("DataTable", () => {
  describe("basic rendering", () => {
    it("renders column headers", () => {
      render(<DataTable data={USERS} columns={COLUMNS} aria-label="User table" />);
      expect(screen.getByText("Name")).toBeInTheDocument();
      expect(screen.getByText("Email")).toBeInTheDocument();
      expect(screen.getByText("Role")).toBeInTheDocument();
      expect(screen.getByText("Age")).toBeInTheDocument();
    });

    it("renders all data rows", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("Bob")).toBeInTheDocument();
      expect(screen.getByText("Carol")).toBeInTheDocument();
    });

    it("uses custom render function for columns", () => {
      const cols: Column<User>[] = [
        {
          key: "name",
          header: "Name",
          render: (value) => <strong data-testid="custom-cell">{String(value)}</strong>,
        },
      ];
      render(<DataTable data={USERS} columns={cols} />);
      const cells = screen.getAllByTestId("custom-cell");
      expect(cells).toHaveLength(3);
      expect(cells[0]).toHaveTextContent("Alice");
    });

    it("applies aria-label to the table element", () => {
      render(<DataTable data={USERS} columns={COLUMNS} aria-label="Custom label" />);
      expect(screen.getByRole("table", { name: "Custom label" })).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Empty / loading states
  // ---------------------------------------------------------------------------

  describe("empty and loading states", () => {
    it("shows default emptyMessage when data is empty", () => {
      render(<DataTable data={[]} columns={COLUMNS} />);
      expect(screen.getByText("No data to display.")).toBeInTheDocument();
    });

    it("shows custom emptyMessage when provided", () => {
      render(<DataTable data={[]} columns={COLUMNS} emptyMessage="Nothing here yet." />);
      expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    });

    it("shows skeleton rows while loading", () => {
      render(<DataTable data={USERS} columns={COLUMNS} loading pageSize={5} />);
      // Skeleton rows are aria-hidden so they don't appear in accessible queries.
      // We check that data cells are absent instead.
      expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    });

    it("marks the table as aria-busy while loading", () => {
      render(<DataTable data={USERS} columns={COLUMNS} loading />);
      expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    });
  });

  // ---------------------------------------------------------------------------
  // Sorting
  // ---------------------------------------------------------------------------

  describe("sorting", () => {
    it("sorts ascending when a sortable column header is clicked", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      fireEvent.click(screen.getByText("Name"));
      // After ascending sort Alice (30) < Bob (25) < Carol (28) alphabetically
      const cells = screen.getAllByRole("cell");
      // First data cell in first data row (after checkbox column) should be "Alice"
      const nameCells = cells.filter((c) => ["Alice", "Bob", "Carol"].includes(c.textContent ?? ""));
      expect(nameCells[0]).toHaveTextContent("Alice");
    });

    it("sorts descending on second click of same column", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      const nameHeader = screen.getByText("Name");
      fireEvent.click(nameHeader); // asc
      fireEvent.click(nameHeader); // desc
      const cells = screen.getAllByRole("cell");
      const nameCells = cells.filter((c) => ["Alice", "Bob", "Carol"].includes(c.textContent ?? ""));
      expect(nameCells[0]).toHaveTextContent("Carol");
    });

    it("clears sort on third click (returns to original order)", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      const nameHeader = screen.getByText("Name");
      fireEvent.click(nameHeader); // asc
      fireEvent.click(nameHeader); // desc
      fireEvent.click(nameHeader); // cleared
      // Unsorted: Alice, Bob, Carol in insertion order
      const cells = screen.getAllByRole("cell");
      const nameCells = cells.filter((c) => ["Alice", "Bob", "Carol"].includes(c.textContent ?? ""));
      expect(nameCells[0]).toHaveTextContent("Alice");
    });

    it("non-sortable column headers are not interactive", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      const emailHeader = screen.getByText("Email");
      // Should not have a tabIndex or aria-sort attribute
      expect(emailHeader).not.toHaveAttribute("aria-sort");
      expect(emailHeader).not.toHaveAttribute("tabindex");
    });

    it("sortable headers expose aria-sort attribute", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      const nameHeader = screen.getByText("Name").closest("th");
      expect(nameHeader).toHaveAttribute("aria-sort", "none");
      fireEvent.click(screen.getByText("Name"));
      expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
      fireEvent.click(screen.getByText("Name"));
      expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    });

    it("activates sort via Enter key for keyboard accessibility", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      const nameHeader = screen.getByText("Name").closest("th") as HTMLElement;
      fireEvent.keyDown(nameHeader, { key: "Enter" });
      expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    });
  });

  // ---------------------------------------------------------------------------
  // Search / filter
  // ---------------------------------------------------------------------------

  describe("search", () => {
    it("filters rows matching the search term", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      const searchInput = screen.getByRole("searchbox");
      fireEvent.change(searchInput, { target: { value: "alice" } });
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    });

    it("shows emptyMessage when search yields no results", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz_no_match" } });
      expect(screen.getByText("No data to display.")).toBeInTheDocument();
    });

    it("resets to page 1 when search changes", () => {
      // Build 25 users to trigger pagination, then filter to force page 1
      const manyUsers: User[] = Array.from({ length: 25 }, (_, i) => ({
        id: String(i),
        name: i === 20 ? "ZZZSpecial" : `User${i}`,
        email: `u${i}@example.com`,
        role: "viewer",
        age: 20 + i,
      }));
      render(<DataTable data={manyUsers} columns={COLUMNS} pageSize={10} />);
      // Navigate to page 2 then filter — should snap back to page 1
      fireEvent.click(screen.getByLabelText("Next page"));
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ZZZSpecial" } });
      expect(screen.getByText("ZZZSpecial")).toBeInTheDocument();
      // Pagination footer should show 1/1 (only 1 match)
      expect(screen.queryByLabelText("Next page")).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  describe("pagination", () => {
    const manyUsers: User[] = Array.from({ length: 25 }, (_, i) => ({
      id: String(i),
      name: `User${i}`,
      email: `u${i}@example.com`,
      role: "viewer",
      age: 20,
    }));

    it("does not render pagination controls when all data fits on one page", () => {
      render(<DataTable data={USERS} columns={COLUMNS} pageSize={10} />);
      expect(screen.queryByLabelText("Next page")).not.toBeInTheDocument();
    });

    it("renders pagination controls for multi-page data", () => {
      render(<DataTable data={manyUsers} columns={COLUMNS} pageSize={10} />);
      expect(screen.getByLabelText("Next page")).toBeInTheDocument();
    });

    it("first page is disabled on first page", () => {
      render(<DataTable data={manyUsers} columns={COLUMNS} pageSize={10} />);
      expect(screen.getByLabelText("First page")).toBeDisabled();
      expect(screen.getByLabelText("Previous page")).toBeDisabled();
    });

    it("last/next page buttons are disabled on last page", () => {
      render(<DataTable data={manyUsers} columns={COLUMNS} pageSize={10} />);
      // Navigate to last page (25 items / 10 per page = 3 pages)
      fireEvent.click(screen.getByLabelText("Last page"));
      expect(screen.getByLabelText("Last page")).toBeDisabled();
      expect(screen.getByLabelText("Next page")).toBeDisabled();
    });

    it("shows correct row count in the page summary", () => {
      render(<DataTable data={manyUsers} columns={COLUMNS} pageSize={10} />);
      expect(screen.getByText(/Showing 1–10 of 25/)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Row selection
  // ---------------------------------------------------------------------------

  describe("row selection", () => {
    it("individual row checkbox selects that row", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      const checkboxes = screen.getAllByRole("checkbox");
      // Index 0 = select-all; index 1 = first row. Non-null assertion is safe
      // because we know USERS has 3 rows so checkboxes has 4 elements.
      fireEvent.click(checkboxes[1]!);
      expect(checkboxes[1]!).toBeChecked();
      // Other rows unchanged
      expect(checkboxes[2]!).not.toBeChecked();
    });

    it("select-all checkbox selects all visible rows", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      const [selectAll, ...rowBoxes] = screen.getAllByRole("checkbox");
      fireEvent.click(selectAll!);
      rowBoxes.forEach((cb) => expect(cb).toBeChecked());
    });

    it("select-all unchecks all when all are already selected", () => {
      render(<DataTable data={USERS} columns={COLUMNS} />);
      const [selectAll, ...rowBoxes] = screen.getAllByRole("checkbox");
      fireEvent.click(selectAll!); // select all
      fireEvent.click(selectAll!); // deselect all
      rowBoxes.forEach((cb) => expect(cb).not.toBeChecked());
    });
  });

  // ---------------------------------------------------------------------------
  // Row click handler
  // ---------------------------------------------------------------------------

  describe("onRowClick", () => {
    it("calls onRowClick with the correct row when a row is clicked", () => {
      const handler = vi.fn();
      render(<DataTable data={USERS} columns={COLUMNS} onRowClick={handler} />);
      fireEvent.click(screen.getByText("Bob").closest("tr")!);
      expect(handler).toHaveBeenCalledWith(USERS[1]);
    });

    it("does not call onRowClick when clicking the row checkbox", () => {
      const handler = vi.fn();
      render(<DataTable data={USERS} columns={COLUMNS} onRowClick={handler} />);
      const [, firstRowCheckbox] = screen.getAllByRole("checkbox");
      fireEvent.click(firstRowCheckbox!); // row checkbox
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
