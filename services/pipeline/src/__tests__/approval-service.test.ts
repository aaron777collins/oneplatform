// Unit tests for services/approval-service.ts
//
// Tests the in-memory ApprovalService that drives human-in-the-loop pipeline
// steps. All state is scoped to individual test cases via fresh service instances.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createApprovalService,
  ApprovalNotFoundError,
  ApprovalUnauthorizedError,
  ApprovalAlreadyDecidedError,
} from "../services/approval-service.js";
import type { ApprovalService } from "../services/approval-service.js";

// ---------------------------------------------------------------------------
// Helper constants
// ---------------------------------------------------------------------------

const EXECUTION_ID = "run-aaa-111";
const STEP_ID = "step-approve";
const APPROVER_A = "user-001";
const APPROVER_B = "user-002";
const NON_APPROVER = "user-999";

// ---------------------------------------------------------------------------
// requestApproval
// ---------------------------------------------------------------------------

describe("ApprovalService — requestApproval", () => {
  let svc: ApprovalService;

  beforeEach(() => {
    svc = createApprovalService();
  });

  it("creates a pending approval record with the correct fields", () => {
    const record = svc.requestApproval(
      EXECUTION_ID,
      STEP_ID,
      [APPROVER_A, APPROVER_B],
      "Please review this step",
      60_000,
    );

    expect(record.executionId).toBe(EXECUTION_ID);
    expect(record.stepId).toBe(STEP_ID);
    expect(record.approvers).toEqual([APPROVER_A, APPROVER_B]);
    expect(record.message).toBe("Please review this step");
    expect(record.status).toBe("pending");
    expect(record.decision).toBeNull();
    expect(record.decidedBy).toBeNull();
    expect(record.decidedAt).toBeNull();
    expect(record.comment).toBeNull();
  });

  it("sets timeoutAt to requestedAt + timeoutMs", () => {
    const before = Date.now();
    const record = svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A], undefined, 30_000);
    const after = Date.now();

    const timeoutAt = new Date(record.timeoutAt).getTime();
    const requestedAt = new Date(record.requestedAt).getTime();

    expect(timeoutAt - requestedAt).toBeGreaterThanOrEqual(30_000);
    // Allow a small clock skew window (50ms)
    expect(timeoutAt).toBeLessThanOrEqual(after + 30_000 + 50);
    expect(timeoutAt).toBeGreaterThanOrEqual(before + 30_000 - 50);
  });

  it("is idempotent — second call with same key returns the existing record unchanged", () => {
    const first = svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A], "msg", 60_000);
    const second = svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_B], "different", 1_000);

    // The second call should return the original record, not overwrite it.
    expect(second.approvers).toEqual([APPROVER_A]);
    expect(second.message).toBe("msg");
    expect(second.requestedAt).toBe(first.requestedAt);
  });

  it("treats undefined message as null in the record", () => {
    const record = svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A], undefined, 60_000);
    expect(record.message).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// submitDecision
// ---------------------------------------------------------------------------

describe("ApprovalService — submitDecision", () => {
  let svc: ApprovalService;

  beforeEach(() => {
    svc = createApprovalService();
    svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A, APPROVER_B], "Review needed", 3_600_000);
  });

  it("records an approved decision with correct metadata", () => {
    const record = svc.submitDecision(EXECUTION_ID, STEP_ID, APPROVER_A, "approved", "LGTM");

    expect(record.status).toBe("approved");
    expect(record.decision).toBe("approved");
    expect(record.decidedBy).toBe(APPROVER_A);
    expect(record.comment).toBe("LGTM");
    expect(record.decidedAt).not.toBeNull();
  });

  it("records a rejected decision with rejection reason", () => {
    const record = svc.submitDecision(EXECUTION_ID, STEP_ID, APPROVER_B, "rejected", "Data looks wrong");

    expect(record.status).toBe("rejected");
    expect(record.decision).toBe("rejected");
    expect(record.decidedBy).toBe(APPROVER_B);
    expect(record.comment).toBe("Data looks wrong");
  });

  it("throws ApprovalNotFoundError when the approval does not exist", () => {
    expect(() =>
      svc.submitDecision(EXECUTION_ID, "nonexistent-step", APPROVER_A, "approved"),
    ).toThrow(ApprovalNotFoundError);
  });

  it("throws ApprovalUnauthorizedError when user is not listed as approver", () => {
    expect(() =>
      svc.submitDecision(EXECUTION_ID, STEP_ID, NON_APPROVER, "approved"),
    ).toThrow(ApprovalUnauthorizedError);
  });

  it("throws ApprovalAlreadyDecidedError when decision was already submitted", () => {
    svc.submitDecision(EXECUTION_ID, STEP_ID, APPROVER_A, "approved");

    expect(() =>
      svc.submitDecision(EXECUTION_ID, STEP_ID, APPROVER_B, "approved"),
    ).toThrow(ApprovalAlreadyDecidedError);
  });

  it("omits comment in record when no comment provided", () => {
    const record = svc.submitDecision(EXECUTION_ID, STEP_ID, APPROVER_A, "approved");
    expect(record.comment).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getApprovalStatus
// ---------------------------------------------------------------------------

describe("ApprovalService — getApprovalStatus", () => {
  let svc: ApprovalService;

  beforeEach(() => {
    svc = createApprovalService();
  });

  it("returns null when no approval exists for the key", () => {
    expect(svc.getApprovalStatus("no-run", "no-step")).toBeNull();
  });

  it("returns the current pending record before timeout", () => {
    svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A], undefined, 3_600_000);
    const record = svc.getApprovalStatus(EXECUTION_ID, STEP_ID);
    expect(record?.status).toBe("pending");
  });

  it("lazily transitions pending to timed_out after the deadline passes", () => {
    vi.useFakeTimers();

    svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A], undefined, 1_000); // 1s timeout

    // Advance time past the timeout
    vi.advanceTimersByTime(2_000);

    const record = svc.getApprovalStatus(EXECUTION_ID, STEP_ID);
    expect(record?.status).toBe("timed_out");

    vi.useRealTimers();
  });

  it("reflects an approved decision immediately after submitDecision", () => {
    svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A], undefined, 3_600_000);
    svc.submitDecision(EXECUTION_ID, STEP_ID, APPROVER_A, "approved");

    const record = svc.getApprovalStatus(EXECUTION_ID, STEP_ID);
    expect(record?.status).toBe("approved");
  });

  it("does not transition to timed_out when already decided", () => {
    vi.useFakeTimers();

    svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A], undefined, 1_000);
    svc.submitDecision(EXECUTION_ID, STEP_ID, APPROVER_A, "approved");

    vi.advanceTimersByTime(5_000);

    // Should remain approved, not overwrite to timed_out
    const record = svc.getApprovalStatus(EXECUTION_ID, STEP_ID);
    expect(record?.status).toBe("approved");

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// listPendingApprovals
// ---------------------------------------------------------------------------

describe("ApprovalService — listPendingApprovals", () => {
  let svc: ApprovalService;

  beforeEach(() => {
    svc = createApprovalService();
  });

  it("returns an empty array when no approvals exist for the execution", () => {
    expect(svc.listPendingApprovals("nonexistent-execution")).toEqual([]);
  });

  it("returns only pending approvals for the given execution", () => {
    svc.requestApproval(EXECUTION_ID, "step-a", [APPROVER_A], undefined, 3_600_000);
    svc.requestApproval(EXECUTION_ID, "step-b", [APPROVER_B], undefined, 3_600_000);
    svc.requestApproval("other-run", "step-c", [APPROVER_A], undefined, 3_600_000);

    const pending = svc.listPendingApprovals(EXECUTION_ID);
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.stepId)).toEqual(
      expect.arrayContaining(["step-a", "step-b"]),
    );
  });

  it("excludes approvals that have been decided", () => {
    svc.requestApproval(EXECUTION_ID, "step-a", [APPROVER_A], undefined, 3_600_000);
    svc.requestApproval(EXECUTION_ID, "step-b", [APPROVER_A], undefined, 3_600_000);
    svc.submitDecision(EXECUTION_ID, "step-a", APPROVER_A, "approved");

    const pending = svc.listPendingApprovals(EXECUTION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.stepId).toBe("step-b");
  });

  it("excludes approvals that have timed out", () => {
    vi.useFakeTimers();

    svc.requestApproval(EXECUTION_ID, "step-a", [APPROVER_A], undefined, 1_000);
    svc.requestApproval(EXECUTION_ID, "step-b", [APPROVER_A], undefined, 60_000);

    vi.advanceTimersByTime(5_000); // only step-a times out

    const pending = svc.listPendingApprovals(EXECUTION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.stepId).toBe("step-b");

    vi.useRealTimers();
  });

  it("returns the full PendingApprovalView shape with all required fields", () => {
    svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A], "Check this", 3_600_000);

    const [view] = svc.listPendingApprovals(EXECUTION_ID);
    expect(view).toBeDefined();
    expect(view?.executionId).toBe(EXECUTION_ID);
    expect(view?.stepId).toBe(STEP_ID);
    expect(view?.approvers).toEqual([APPROVER_A]);
    expect(view?.message).toBe("Check this");
    expect(view?.status).toBe("pending");
    expect(typeof view?.requestedAt).toBe("string");
    expect(typeof view?.timeoutAt).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Only listed approvers can submit decisions (security boundary)
// ---------------------------------------------------------------------------

describe("ApprovalService — approver enforcement", () => {
  let svc: ApprovalService;

  beforeEach(() => {
    svc = createApprovalService();
  });

  it("allows the first listed approver to decide", () => {
    svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A, APPROVER_B], undefined, 3_600_000);
    const record = svc.submitDecision(EXECUTION_ID, STEP_ID, APPROVER_A, "approved");
    expect(record.status).toBe("approved");
  });

  it("allows any listed approver to decide (not just the first)", () => {
    svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A, APPROVER_B], undefined, 3_600_000);
    const record = svc.submitDecision(EXECUTION_ID, STEP_ID, APPROVER_B, "rejected");
    expect(record.status).toBe("rejected");
  });

  it("rejects a non-approver even if they attempt to provide a valid decision", () => {
    svc.requestApproval(EXECUTION_ID, STEP_ID, [APPROVER_A], undefined, 3_600_000);
    expect(() =>
      svc.submitDecision(EXECUTION_ID, STEP_ID, NON_APPROVER, "approved"),
    ).toThrow(ApprovalUnauthorizedError);

    // Confirm the record is still pending (no side-effects from the rejected attempt)
    const record = svc.getApprovalStatus(EXECUTION_ID, STEP_ID);
    expect(record?.status).toBe("pending");
  });
});
