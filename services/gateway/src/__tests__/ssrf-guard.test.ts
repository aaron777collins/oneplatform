// Unit tests for utils/ssrf-guard.ts
//
// Tests isBlockedIpRange (CIDR matching, IPv6), isBlockedHostname (pattern
// matching), and validateWebhookUrl (protocol enforcement, hostname blocking,
// plus DNS resolution — the latter is integration-style but uses real DNS so
// we stub external calls with a mock module and test the logic branches).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isBlockedIpRange, isBlockedHostname } from "../utils/ssrf-guard.js";
import { WebhookInvalidUrlError, WebhookSsrfBlockedError } from "../services/errors.js";

// ---------------------------------------------------------------------------
// isBlockedIpRange — private CIDR blocks
// ---------------------------------------------------------------------------

describe("isBlockedIpRange — 10.0.0.0/8", () => {
  it("blocks 10.0.0.0 (network address)", () => {
    expect(isBlockedIpRange("10.0.0.0")).toBe(true);
  });

  it("blocks 10.0.0.1", () => {
    expect(isBlockedIpRange("10.0.0.1")).toBe(true);
  });

  it("blocks 10.255.255.255 (broadcast)", () => {
    expect(isBlockedIpRange("10.255.255.255")).toBe(true);
  });

  it("blocks 10.100.50.25 (mid-range)", () => {
    expect(isBlockedIpRange("10.100.50.25")).toBe(true);
  });

  it("does not block 11.0.0.0 (outside the /8)", () => {
    expect(isBlockedIpRange("11.0.0.0")).toBe(false);
  });

  it("does not block 9.255.255.255", () => {
    expect(isBlockedIpRange("9.255.255.255")).toBe(false);
  });
});

describe("isBlockedIpRange — 172.16.0.0/12", () => {
  it("blocks 172.16.0.0 (first address)", () => {
    expect(isBlockedIpRange("172.16.0.0")).toBe(true);
  });

  it("blocks 172.16.0.1", () => {
    expect(isBlockedIpRange("172.16.0.1")).toBe(true);
  });

  it("blocks 172.31.255.255 (last address in /12)", () => {
    expect(isBlockedIpRange("172.31.255.255")).toBe(true);
  });

  it("blocks 172.20.10.5 (mid-range)", () => {
    expect(isBlockedIpRange("172.20.10.5")).toBe(true);
  });

  it("does not block 172.15.255.255 (just outside the /12)", () => {
    expect(isBlockedIpRange("172.15.255.255")).toBe(false);
  });

  it("does not block 172.32.0.0 (just outside the /12)", () => {
    expect(isBlockedIpRange("172.32.0.0")).toBe(false);
  });
});

describe("isBlockedIpRange — 192.168.0.0/16", () => {
  it("blocks 192.168.0.0", () => {
    expect(isBlockedIpRange("192.168.0.0")).toBe(true);
  });

  it("blocks 192.168.1.1", () => {
    expect(isBlockedIpRange("192.168.1.1")).toBe(true);
  });

  it("blocks 192.168.255.255", () => {
    expect(isBlockedIpRange("192.168.255.255")).toBe(true);
  });

  it("does not block 192.167.255.255", () => {
    expect(isBlockedIpRange("192.167.255.255")).toBe(false);
  });

  it("does not block 192.169.0.0", () => {
    expect(isBlockedIpRange("192.169.0.0")).toBe(false);
  });
});

describe("isBlockedIpRange — 127.0.0.0/8 (loopback)", () => {
  it("blocks 127.0.0.1 (classic localhost)", () => {
    expect(isBlockedIpRange("127.0.0.1")).toBe(true);
  });

  it("blocks 127.0.0.0 (network address)", () => {
    expect(isBlockedIpRange("127.0.0.0")).toBe(true);
  });

  it("blocks 127.255.255.255", () => {
    expect(isBlockedIpRange("127.255.255.255")).toBe(true);
  });

  it("blocks 127.1.2.3", () => {
    expect(isBlockedIpRange("127.1.2.3")).toBe(true);
  });

  it("does not block 128.0.0.1", () => {
    expect(isBlockedIpRange("128.0.0.1")).toBe(false);
  });

  it("does not block 126.255.255.255", () => {
    expect(isBlockedIpRange("126.255.255.255")).toBe(false);
  });
});

describe("isBlockedIpRange — 169.254.0.0/16 (link-local / IMDS)", () => {
  it("blocks 169.254.169.254 (AWS/GCP IMDS endpoint)", () => {
    expect(isBlockedIpRange("169.254.169.254")).toBe(true);
  });

  it("blocks 169.254.0.0 (first address)", () => {
    expect(isBlockedIpRange("169.254.0.0")).toBe(true);
  });

  it("blocks 169.254.255.255 (last address)", () => {
    expect(isBlockedIpRange("169.254.255.255")).toBe(true);
  });

  it("does not block 169.253.255.255", () => {
    expect(isBlockedIpRange("169.253.255.255")).toBe(false);
  });

  it("does not block 169.255.0.0", () => {
    expect(isBlockedIpRange("169.255.0.0")).toBe(false);
  });
});

describe("isBlockedIpRange — public IPv4 addresses", () => {
  it("does not block 1.1.1.1 (Cloudflare DNS)", () => {
    expect(isBlockedIpRange("1.1.1.1")).toBe(false);
  });

  it("does not block 8.8.8.8 (Google DNS)", () => {
    expect(isBlockedIpRange("8.8.8.8")).toBe(false);
  });

  it("does not block 93.184.216.34 (example.com)", () => {
    expect(isBlockedIpRange("93.184.216.34")).toBe(false);
  });

  it("does not block 0.0.0.0", () => {
    expect(isBlockedIpRange("0.0.0.0")).toBe(false);
  });

  it("does not block 255.255.255.255", () => {
    expect(isBlockedIpRange("255.255.255.255")).toBe(false);
  });
});

describe("isBlockedIpRange — IPv6", () => {
  it("blocks ::1 (IPv6 loopback)", () => {
    expect(isBlockedIpRange("::1")).toBe(true);
  });

  it("does not block ::2 (not a blocked range)", () => {
    expect(isBlockedIpRange("::2")).toBe(false);
  });

  it("does not block a public IPv6 address", () => {
    expect(isBlockedIpRange("2001:db8::1")).toBe(false);
  });
});

describe("isBlockedIpRange — IPv4-mapped IPv6 (::ffff:x.x.x.x)", () => {
  it("blocks ::ffff:10.0.0.1 (mapped 10.x address)", () => {
    expect(isBlockedIpRange("::ffff:10.0.0.1")).toBe(true);
  });

  it("blocks ::ffff:127.0.0.1 (mapped loopback)", () => {
    expect(isBlockedIpRange("::ffff:127.0.0.1")).toBe(true);
  });

  it("blocks ::ffff:192.168.1.1 (mapped LAN)", () => {
    expect(isBlockedIpRange("::ffff:192.168.1.1")).toBe(true);
  });

  it("blocks ::ffff:169.254.169.254 (mapped IMDS)", () => {
    expect(isBlockedIpRange("::ffff:169.254.169.254")).toBe(true);
  });

  it("does not block ::ffff:1.1.1.1 (mapped public IP)", () => {
    expect(isBlockedIpRange("::ffff:1.1.1.1")).toBe(false);
  });

  it("handles uppercase ::FFFF: prefix (case-insensitive match)", () => {
    expect(isBlockedIpRange("::FFFF:10.0.0.1")).toBe(true);
  });
});

describe("isBlockedIpRange — malformed input", () => {
  it("returns false for an empty string", () => {
    expect(isBlockedIpRange("")).toBe(false);
  });

  it("returns false for a hostname string", () => {
    expect(isBlockedIpRange("example.com")).toBe(false);
  });

  it("returns false for a partial IP", () => {
    expect(isBlockedIpRange("10.0.0")).toBe(false);
  });

  it("returns false for text that is not an IP", () => {
    expect(isBlockedIpRange("not-an-ip")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBlockedHostname
// ---------------------------------------------------------------------------

describe("isBlockedHostname — localhost", () => {
  it("blocks 'localhost' exactly", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
  });

  it("blocks 'LOCALHOST' (case-insensitive)", () => {
    expect(isBlockedHostname("LOCALHOST")).toBe(true);
  });

  it("blocks 'LocalHost' (mixed case)", () => {
    expect(isBlockedHostname("LocalHost")).toBe(true);
  });

  it("does not block 'notlocalhost'", () => {
    expect(isBlockedHostname("notlocalhost")).toBe(false);
  });

  it("does not block 'localhost.example.com'", () => {
    expect(isBlockedHostname("localhost.example.com")).toBe(false);
  });
});

describe("isBlockedHostname — *.local (mDNS)", () => {
  it("blocks 'host.local'", () => {
    expect(isBlockedHostname("host.local")).toBe(true);
  });

  it("blocks 'my-service.local'", () => {
    expect(isBlockedHostname("my-service.local")).toBe(true);
  });

  it("blocks 'a.b.c.local' (deep subdomain)", () => {
    expect(isBlockedHostname("a.b.c.local")).toBe(true);
  });

  it("blocks 'LOCAL' as suffix (case-insensitive)", () => {
    expect(isBlockedHostname("host.LOCAL")).toBe(true);
  });

  it("does not block 'notlocal' (does not end with .local)", () => {
    expect(isBlockedHostname("notlocal")).toBe(false);
  });

  it("does not block 'example.com.locality'", () => {
    expect(isBlockedHostname("example.com.locality")).toBe(false);
  });
});

describe("isBlockedHostname — *-service (Docker Compose names)", () => {
  it("blocks 'auth-service'", () => {
    expect(isBlockedHostname("auth-service")).toBe(true);
  });

  it("blocks 'ontology-service'", () => {
    expect(isBlockedHostname("ontology-service")).toBe(true);
  });

  it("blocks 'my-cool-service'", () => {
    expect(isBlockedHostname("my-cool-service")).toBe(true);
  });

  it("blocks 'SERVICE' suffix is case-insensitive", () => {
    expect(isBlockedHostname("auth-SERVICE")).toBe(true);
  });

  it("does not block 'service' alone (no hyphen prefix)", () => {
    expect(isBlockedHostname("service")).toBe(false);
  });

  it("does not block 'myservice' (no hyphen before 'service')", () => {
    // endsWith('-service') is the check — 'myservice' does not end with '-service'
    expect(isBlockedHostname("myservice")).toBe(false);
  });

  it("does not block 'example.com' that coincidentally ends in a word", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
  });
});

describe("isBlockedHostname — legitimate public hostnames", () => {
  it("allows 'example.com'", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
  });

  it("allows 'api.stripe.com'", () => {
    expect(isBlockedHostname("api.stripe.com")).toBe(false);
  });

  it("allows 'hooks.slack.com'", () => {
    expect(isBlockedHostname("hooks.slack.com")).toBe(false);
  });

  it("allows 'sub.domain.example.org'", () => {
    expect(isBlockedHostname("sub.domain.example.org")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateWebhookUrl — protocol enforcement
// ---------------------------------------------------------------------------

// NOTE: validateWebhookUrl does real DNS resolution which we do NOT mock in
// unit tests. We only test the path branches that fire BEFORE DNS resolution:
// malformed URL, wrong protocol, and blocked hostname. We achieve this by
// using hostnames that are blocked at the hostname check stage so DNS is
// never reached.

import { validateWebhookUrl } from "../utils/ssrf-guard.js";

describe("validateWebhookUrl — malformed URLs", () => {
  it("rejects a completely malformed string", async () => {
    await expect(validateWebhookUrl("not-a-url")).rejects.toBeInstanceOf(WebhookInvalidUrlError);
  });

  it("rejects an empty string", async () => {
    await expect(validateWebhookUrl("")).rejects.toBeInstanceOf(WebhookInvalidUrlError);
  });

  it("rejects a string with no protocol", async () => {
    await expect(validateWebhookUrl("example.com/hook")).rejects.toBeInstanceOf(WebhookInvalidUrlError);
  });

  it("rejects a URL with just a path", async () => {
    await expect(validateWebhookUrl("/path/to/hook")).rejects.toBeInstanceOf(WebhookInvalidUrlError);
  });
});

describe("validateWebhookUrl — protocol enforcement (https required)", () => {
  beforeEach(() => {
    delete process.env["OP_WEBHOOK_ALLOW_HTTP"];
  });
  afterEach(() => {
    delete process.env["OP_WEBHOOK_ALLOW_HTTP"];
  });

  it("rejects http:// URLs when OP_WEBHOOK_ALLOW_HTTP is not set", async () => {
    await expect(
      validateWebhookUrl("http://localhost/hook")
    ).rejects.toBeInstanceOf(WebhookInvalidUrlError);
  });

  it("rejects ftp:// URLs unconditionally", async () => {
    await expect(
      validateWebhookUrl("ftp://example.com/hook")
    ).rejects.toBeInstanceOf(WebhookInvalidUrlError);
  });

  it("rejects ws:// URLs", async () => {
    await expect(
      validateWebhookUrl("ws://example.com/hook")
    ).rejects.toBeInstanceOf(WebhookInvalidUrlError);
  });

  it("accepts http:// when OP_WEBHOOK_ALLOW_HTTP=true (but still blocks hostname if blocked)", async () => {
    process.env["OP_WEBHOOK_ALLOW_HTTP"] = "true";
    // localhost is a blocked hostname → should get WebhookSsrfBlockedError not WebhookInvalidUrlError
    await expect(
      validateWebhookUrl("http://localhost/hook")
    ).rejects.toBeInstanceOf(WebhookSsrfBlockedError);
  });

  it("does not accept http:// when OP_WEBHOOK_ALLOW_HTTP is 'false' (string)", async () => {
    process.env["OP_WEBHOOK_ALLOW_HTTP"] = "false";
    await expect(
      validateWebhookUrl("http://localhost/hook")
    ).rejects.toBeInstanceOf(WebhookInvalidUrlError);
  });
});

describe("validateWebhookUrl — hostname blocking (before DNS)", () => {
  beforeEach(() => {
    delete process.env["OP_WEBHOOK_ALLOW_HTTP"];
  });

  it("rejects https://localhost/ with WebhookSsrfBlockedError", async () => {
    await expect(
      validateWebhookUrl("https://localhost/hook")
    ).rejects.toBeInstanceOf(WebhookSsrfBlockedError);
  });

  it("rejects https://auth-service/hook with WebhookSsrfBlockedError", async () => {
    await expect(
      validateWebhookUrl("https://auth-service/hook")
    ).rejects.toBeInstanceOf(WebhookSsrfBlockedError);
  });

  it("rejects https://myapp.local/hook with WebhookSsrfBlockedError", async () => {
    await expect(
      validateWebhookUrl("https://myapp.local/hook")
    ).rejects.toBeInstanceOf(WebhookSsrfBlockedError);
  });

  it("rejects https://ontology-service/events with WebhookSsrfBlockedError", async () => {
    await expect(
      validateWebhookUrl("https://ontology-service/events")
    ).rejects.toBeInstanceOf(WebhookSsrfBlockedError);
  });

  it("WebhookSsrfBlockedError has statusCode 422", async () => {
    try {
      await validateWebhookUrl("https://localhost/hook");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookSsrfBlockedError);
      expect((err as WebhookSsrfBlockedError).statusCode).toBe(422);
    }
  });

  it("WebhookInvalidUrlError has statusCode 422", async () => {
    try {
      await validateWebhookUrl("not-a-url");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookInvalidUrlError);
      expect((err as WebhookInvalidUrlError).statusCode).toBe(422);
    }
  });
});
