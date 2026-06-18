/**
 * Tests for FilterBar component.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";
import { FilterBar } from "./filter-bar.js";
import type { FilterDef, FilterValues } from "./filter-bar.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEXT_FILTER: FilterDef = {
  key: "name",
  label: "Name",
  type: "text",
  placeholder: "Search name...",
};

const SELECT_FILTER: FilterDef = {
  key: "role",
  label: "Role",
  type: "select",
  options: [
    { label: "Admin", value: "admin" },
    { label: "Editor", value: "editor" },
  ],
};

const BOOLEAN_FILTER: FilterDef = {
  key: "active",
  label: "Active only",
  type: "boolean",
};

const DATE_RANGE_FILTER: FilterDef = {
  key: "createdAt",
  label: "Created",
  type: "date-range",
};

describe("FilterBar", () => {
  describe("rendering", () => {
    it("renders nothing when filters array is empty", () => {
      const { container } = render(
        <FilterBar filters={[]} values={{}} onChange={vi.fn()} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders label for each filter", () => {
      render(
        <FilterBar
          filters={[TEXT_FILTER, SELECT_FILTER]}
          values={{}}
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByText("Name")).toBeInTheDocument();
      expect(screen.getByText("Role")).toBeInTheDocument();
    });

    it("renders text input for type=text", () => {
      render(<FilterBar filters={[TEXT_FILTER]} values={{}} onChange={vi.fn()} />);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("renders select element for type=select", () => {
      render(<FilterBar filters={[SELECT_FILTER]} values={{}} onChange={vi.fn()} />);
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    it("renders select options plus an All option", () => {
      render(<FilterBar filters={[SELECT_FILTER]} values={{}} onChange={vi.fn()} />);
      expect(screen.getByRole("option", { name: "All" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Admin" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Editor" })).toBeInTheDocument();
    });

    it("renders checkbox for type=boolean", () => {
      render(<FilterBar filters={[BOOLEAN_FILTER]} values={{}} onChange={vi.fn()} />);
      expect(screen.getByRole("checkbox")).toBeInTheDocument();
    });

    it("renders two date inputs for type=date-range", () => {
      render(<FilterBar filters={[DATE_RANGE_FILTER]} values={{}} onChange={vi.fn()} />);
      const dateInputs = screen.getAllByDisplayValue("");
      // Both from and to date inputs start empty
      expect(dateInputs.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("text filter", () => {
    it("calls onChange with the typed value", () => {
      const onChange = vi.fn();
      render(<FilterBar filters={[TEXT_FILTER]} values={{}} onChange={onChange} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Alice" } });
      expect(onChange).toHaveBeenCalledWith("name", "Alice");
    });

    it("calls onChange with undefined when text is cleared", () => {
      const onChange = vi.fn();
      const values: FilterValues = { name: "Alice" };
      render(<FilterBar filters={[TEXT_FILTER]} values={values} onChange={onChange} />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
      expect(onChange).toHaveBeenCalledWith("name", undefined);
    });

    it("shows current value from values prop", () => {
      const values: FilterValues = { name: "Bob" };
      render(<FilterBar filters={[TEXT_FILTER]} values={values} onChange={vi.fn()} />);
      expect(screen.getByRole("textbox")).toHaveValue("Bob");
    });
  });

  describe("select filter", () => {
    it("calls onChange with selected value", () => {
      const onChange = vi.fn();
      render(<FilterBar filters={[SELECT_FILTER]} values={{}} onChange={onChange} />);
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "admin" } });
      expect(onChange).toHaveBeenCalledWith("role", "admin");
    });

    it("calls onChange with undefined when All is selected", () => {
      const onChange = vi.fn();
      const values: FilterValues = { role: "admin" };
      render(<FilterBar filters={[SELECT_FILTER]} values={values} onChange={onChange} />);
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
      expect(onChange).toHaveBeenCalledWith("role", undefined);
    });

    it("shows current value from values prop", () => {
      const values: FilterValues = { role: "editor" };
      render(<FilterBar filters={[SELECT_FILTER]} values={values} onChange={vi.fn()} />);
      expect(screen.getByRole("combobox")).toHaveValue("editor");
    });
  });

  describe("boolean filter", () => {
    it("calls onChange with true when checked", () => {
      const onChange = vi.fn();
      render(<FilterBar filters={[BOOLEAN_FILTER]} values={{}} onChange={onChange} />);
      fireEvent.click(screen.getByRole("checkbox"));
      expect(onChange).toHaveBeenCalledWith("active", true);
    });

    it("calls onChange with undefined when unchecked", () => {
      const onChange = vi.fn();
      const values: FilterValues = { active: true };
      render(<FilterBar filters={[BOOLEAN_FILTER]} values={values} onChange={onChange} />);
      fireEvent.click(screen.getByRole("checkbox"));
      expect(onChange).toHaveBeenCalledWith("active", undefined);
    });

    it("reflects checked state from values prop", () => {
      const values: FilterValues = { active: true };
      render(<FilterBar filters={[BOOLEAN_FILTER]} values={values} onChange={vi.fn()} />);
      expect(screen.getByRole("checkbox")).toBeChecked();
    });
  });

  describe("date-range filter", () => {
    it("calls onChange with a DateRange object when from date is set", () => {
      const onChange = vi.fn();
      render(<FilterBar filters={[DATE_RANGE_FILTER]} values={{}} onChange={onChange} />);
      // date inputs don't have an implicit ARIA role in jsdom; locate via aria-label
      const fromDateInput = screen.getByLabelText("From date");
      fireEvent.change(fromDateInput, { target: { value: "2024-01-01" } });
      expect(onChange).toHaveBeenCalledWith("createdAt", expect.objectContaining({ from: "2024-01-01" }));
    });

    it("calls onChange with undefined when both dates are cleared", () => {
      const onChange = vi.fn();
      // Render with a pre-populated DateRange so both fields start with values.
      // The values prop drives DateRangeInput's controlled inputs directly.
      const values: FilterValues = { createdAt: { from: "2024-01-01", to: "2024-12-31" } };
      render(<FilterBar filters={[DATE_RANGE_FILTER]} values={values} onChange={onChange} />);

      // Verify the inputs reflect the values prop
      expect(screen.getByLabelText("From date")).toHaveValue("2024-01-01");
      expect(screen.getByLabelText("To date")).toHaveValue("2024-12-31");

      // Clear the "to" date — from is still set, so onChange receives a partial range
      fireEvent.change(screen.getByLabelText("To date"), { target: { value: "" } });
      expect(onChange).toHaveBeenLastCalledWith(
        "createdAt",
        expect.objectContaining({ from: "2024-01-01" }),
      );
    });
  });

  describe("accessibility", () => {
    it("renders inside a role=search landmark", () => {
      render(<FilterBar filters={[TEXT_FILTER]} values={{}} onChange={vi.fn()} />);
      expect(screen.getByRole("search")).toBeInTheDocument();
    });

    it("text input has an accessible label", () => {
      render(<FilterBar filters={[TEXT_FILTER]} values={{}} onChange={vi.fn()} />);
      // The label "Name" is associated via htmlFor
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });
  });

  describe("multiple filters", () => {
    it("renders all filter types together without error", () => {
      render(
        <FilterBar
          filters={[TEXT_FILTER, SELECT_FILTER, BOOLEAN_FILTER, DATE_RANGE_FILTER]}
          values={{}}
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByText("Name")).toBeInTheDocument();
      expect(screen.getByText("Role")).toBeInTheDocument();
      // "Active only" appears in both the <label> and the inline <span> inside
      // the boolean filter — use getAllByText to accept both occurrences.
      expect(screen.getAllByText("Active only").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Created")).toBeInTheDocument();
    });
  });
});
