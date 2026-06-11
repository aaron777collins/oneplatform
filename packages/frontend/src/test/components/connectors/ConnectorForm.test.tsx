/**
 * ConnectorForm tests
 *
 * ConnectorForm builds a form dynamically from a JSON Schema. Tests cover
 * each supported field type, password detection heuristics, validation, and
 * submission behaviour.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import {
  ConnectorForm,
  type ConnectorConfigSchema,
  type ConnectorFormValues,
} from "@/components/connectors/ConnectorForm.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderForm(
  schema: ConnectorConfigSchema,
  overrides: {
    defaultValues?: ConnectorFormValues;
    onSubmit?: (values: ConnectorFormValues) => void;
    isSubmitting?: boolean;
    submitLabel?: string;
  } = {},
) {
  const onSubmit = overrides.onSubmit ?? vi.fn();
  return {
    ...render(
      <ConnectorForm
        schema={schema}
        onSubmit={onSubmit}
        {...(overrides.defaultValues !== undefined ? { defaultValues: overrides.defaultValues } : {})}
        {...(overrides.isSubmitting !== undefined ? { isSubmitting: overrides.isSubmitting } : {})}
        {...(overrides.submitLabel !== undefined ? { submitLabel: overrides.submitLabel } : {})}
      />,
    ),
    onSubmit,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectorForm", () => {
  const user = userEvent.setup();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("string property", () => {
    it("renders a text input for a plain string field", () => {
      renderForm({
        type: "object",
        properties: { host: { type: "string", title: "Host" } },
      });
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("renders the field title as a label", () => {
      renderForm({
        type: "object",
        properties: { host: { type: "string", title: "Hostname" } },
      });
      // The FormLabel renders as a <label> element — use getByText to avoid
      // the labellable-element constraint from getByLabelText.
      expect(screen.getByText(/hostname/i)).toBeInTheDocument();
    });
  });

  describe("password detection", () => {
    it("renders a password input when format is 'password'", () => {
      renderForm({
        type: "object",
        properties: {
          secret: { type: "string", format: "password", title: "Secret" },
        },
      });
      const input = document.querySelector("input[type='password']");
      expect(input).toBeInTheDocument();
    });

    it("renders a password input when the field key is 'apiToken'", () => {
      renderForm({
        type: "object",
        properties: { apiToken: { type: "string", title: "API Token" } },
      });
      const input = document.querySelector("input[type='password']");
      expect(input).toBeInTheDocument();
    });

    it("renders a password input for a field key containing 'password'", () => {
      renderForm({
        type: "object",
        properties: { adminPassword: { type: "string", title: "Admin Password" } },
      });
      const input = document.querySelector("input[type='password']");
      expect(input).toBeInTheDocument();
    });

    it("shows a toggle button on password fields", () => {
      renderForm({
        type: "object",
        properties: { apiKey: { type: "string", title: "API Key" } },
      });
      expect(screen.getByRole("button", { name: /show field/i })).toBeInTheDocument();
    });
  });

  describe("boolean property", () => {
    it("renders a checkbox for a boolean field", () => {
      renderForm({
        type: "object",
        properties: { enabled: { type: "boolean", title: "Enabled" } },
      });
      expect(screen.getByRole("checkbox")).toBeInTheDocument();
    });

    it("uses the field title as the label for the checkbox", () => {
      renderForm({
        type: "object",
        properties: { ssl: { type: "boolean", title: "Use SSL" } },
      });
      expect(screen.getByText(/use ssl/i)).toBeInTheDocument();
    });
  });

  describe("number property", () => {
    it("renders a number input for an integer field", () => {
      renderForm({
        type: "object",
        properties: { port: { type: "integer", title: "Port" } },
      });
      const input = document.querySelector("input[type='number']");
      expect(input).toBeInTheDocument();
    });

    it("renders a number input for a number field", () => {
      renderForm({
        type: "object",
        properties: { timeout: { type: "number", title: "Timeout" } },
      });
      const input = document.querySelector("input[type='number']");
      expect(input).toBeInTheDocument();
    });
  });

  describe("enum property", () => {
    it("renders a Select trigger for an enum field", () => {
      renderForm({
        type: "object",
        properties: {
          region: {
            type: "string",
            title: "Region",
            enum: ["us-east-1", "eu-west-1", "ap-southeast-1"],
          },
        },
      });
      // Radix Select renders a button with role="combobox"
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });
  });

  describe("required field validation", () => {
    it("shows a validation error when a required field is left empty on submit", async () => {
      renderForm({
        type: "object",
        required: ["host"],
        properties: { host: { type: "string", title: "Host" } },
      });

      await user.click(screen.getByRole("button", { name: /save/i }));

      // Zod emits "Required" for undefined required fields; the .min(1, ...) message
      // fires for empty strings. Either way, a form error message is shown.
      await waitFor(() => {
        const errorMsg = document.querySelector("[id*='form-item-message']");
        expect(errorMsg).toBeInTheDocument();
        expect(errorMsg?.textContent?.length).toBeGreaterThan(0);
      });
    });

    it("does not call onSubmit when validation fails", async () => {
      const onSubmit = vi.fn();
      renderForm(
        {
          type: "object",
          required: ["host"],
          properties: { host: { type: "string", title: "Host" } },
        },
        { onSubmit },
      );

      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        const errorMsg = document.querySelector("[id*='form-item-message']");
        expect(errorMsg).toBeInTheDocument();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe("defaultValues", () => {
    it("pre-populates string fields from defaultValues", () => {
      renderForm(
        {
          type: "object",
          properties: { host: { type: "string", title: "Host" } },
        },
        { defaultValues: { host: "db.example.com" } },
      );
      expect(screen.getByDisplayValue("db.example.com")).toBeInTheDocument();
    });
  });

  describe("valid submission", () => {
    it("calls onSubmit with form values after filling required fields", async () => {
      const onSubmit = vi.fn();
      renderForm(
        {
          type: "object",
          required: ["host"],
          properties: { host: { type: "string", title: "Host" } },
        },
        { onSubmit },
      );

      await user.type(screen.getByRole("textbox"), "db.example.com");
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ host: "db.example.com" }),
        );
      });
    });
  });

  describe("isSubmitting prop", () => {
    it("disables the submit button when isSubmitting is true", () => {
      renderForm(
        { type: "object", properties: {} },
        { isSubmitting: true },
      );
      expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
    });

    it("shows 'Saving…' text when isSubmitting is true", () => {
      renderForm(
        { type: "object", properties: {} },
        { isSubmitting: true },
      );
      expect(screen.getByText(/saving/i)).toBeInTheDocument();
    });
  });

  describe("empty schema.properties", () => {
    it("renders only the submit button when properties is empty", () => {
      renderForm({ type: "object", properties: {} });
      expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
      // No input fields
      expect(screen.queryAllByRole("textbox")).toHaveLength(0);
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });
  });

  describe("custom submitLabel", () => {
    it("uses the provided submitLabel on the submit button", () => {
      renderForm(
        { type: "object", properties: {} },
        { submitLabel: "Connect" },
      );
      expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
    });
  });
});
