import { describe, it, expect } from "vitest";
import {
  PluginError,
  PluginAuthError,
  PluginRateLimitError,
  PluginTimeoutError,
  PluginDataError,
  PluginConfigError,
} from "../types/errors.js";

describe("PluginError hierarchy", () => {
  it("PluginAuthError is instanceof PluginError and PluginAuthError", () => {
    const err = new PluginAuthError("bad credentials");
    expect(err).toBeInstanceOf(PluginError);
    expect(err).toBeInstanceOf(PluginAuthError);
  });

  it("PluginAuthError has isRetryable=false", () => {
    const err = new PluginAuthError("bad credentials");
    expect(err.isRetryable).toBe(false);
    expect(err.code).toBe("PLUGIN_AUTH_ERROR");
  });

  it("PluginRateLimitError has isRetryable=true", () => {
    const err = new PluginRateLimitError("too many requests", 60);
    expect(err.isRetryable).toBe(true);
    expect(err.code).toBe("PLUGIN_RATE_LIMIT");
    expect(err.retryAfterSeconds).toBe(60);
  });

  it("PluginTimeoutError has isRetryable=true", () => {
    const err = new PluginTimeoutError("timed out");
    expect(err.isRetryable).toBe(true);
    expect(err.code).toBe("PLUGIN_TIMEOUT");
  });

  it("PluginDataError has isRetryable=false and sample", () => {
    const sample = { email: 12345 };
    const err = new PluginDataError("bad data", sample);
    expect(err.isRetryable).toBe(false);
    expect(err.code).toBe("PLUGIN_DATA_ERROR");
    expect(err.sample).toBe(sample);
  });

  it("PluginConfigError has isRetryable=false and field", () => {
    const err = new PluginConfigError("baseUrl is required", "baseUrl");
    expect(err.isRetryable).toBe(false);
    expect(err.code).toBe("PLUGIN_CONFIG_ERROR");
    expect(err.field).toBe("baseUrl");
  });

  it("sets .name to constructor name for all subclasses", () => {
    expect(new PluginAuthError("x").name).toBe("PluginAuthError");
    expect(new PluginRateLimitError("x").name).toBe("PluginRateLimitError");
    expect(new PluginTimeoutError("x").name).toBe("PluginTimeoutError");
    expect(new PluginDataError("x").name).toBe("PluginDataError");
    expect(new PluginConfigError("x").name).toBe("PluginConfigError");
  });

  it("prototype chain is preserved (instanceof works correctly)", () => {
    const errors: PluginError[] = [
      new PluginAuthError("a"),
      new PluginRateLimitError("b"),
      new PluginTimeoutError("c"),
      new PluginDataError("d"),
      new PluginConfigError("e"),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(PluginError);
    }
  });

  it("does not mix up instanceof across subclasses", () => {
    const authErr = new PluginAuthError("auth");
    const configErr = new PluginConfigError("config");

    expect(authErr).not.toBeInstanceOf(PluginConfigError);
    expect(configErr).not.toBeInstanceOf(PluginAuthError);
  });
});
