// Approval Service — in-memory store for human-in-the-loop approval state.
//
// Why in-memory: approval decisions are short-lived control-flow signals.
// The authoritative record of the decision is the run_step row (written by the
// execution engine when it acts on the decision). The in-memory store exists so
// the execution engine can poll for decisions without hitting the DB on every tick,
// and so the approval list API can serve quick responses.
//
// Structure mirrors ExecutionTracker: keyed by `${executionId}:${stepId}` so
// approvals are scoped to a specific step within a specific run.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApprovalDecision = "approved" | "rejected";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timed_out";

export interface ApprovalRecord {
  executionId: string;
  stepId: string;
  approvers: string[];     // user IDs that may submit a decision
  message: string | null;
  status: ApprovalStatus;
  requestedAt: string;     // ISO timestamp
  decidedAt: string | null;
  decidedBy: string | null;
  decision: ApprovalDecision | null;
  comment: string | null;
  timeoutAt: string;       // ISO timestamp after which the step auto-fails
}

export interface PendingApprovalView {
  executionId: string;
  stepId: string;
  approvers: string[];
  message: string | null;
  status: ApprovalStatus;
  requestedAt: string;
  timeoutAt: string;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ApprovalService {
  /**
   * Create a pending approval request for an approval step.
   * Idempotent — calling it again for the same key is a no-op.
   */
  requestApproval(
    executionId: string,
    stepId: string,
    approvers: string[],
    message: string | undefined,
    timeoutMs: number,
  ): ApprovalRecord;

  /**
   * Submit a human decision for a pending approval.
   * Throws ApprovalNotFoundError if the approval does not exist.
   * Throws ApprovalUnauthorizedError if userId is not in the approvers list.
   * Throws ApprovalAlreadyDecidedError if a decision was already recorded.
   */
  submitDecision(
    executionId: string,
    stepId: string,
    userId: string,
    decision: ApprovalDecision,
    comment?: string,
  ): ApprovalRecord;

  /**
   * Return the current status of an approval request, or null if not found.
   * The caller should also call this to handle the timed_out transition:
   * if requestedAt + timeoutMs < now the approval is expired.
   */
  getApprovalStatus(executionId: string, stepId: string): ApprovalRecord | null;

  /**
   * List all pending (not yet decided) approval records for an execution.
   */
  listPendingApprovals(executionId: string): PendingApprovalView[];
}

// ---------------------------------------------------------------------------
// Error types — used by routes and the execution engine
// ---------------------------------------------------------------------------

export class ApprovalNotFoundError extends Error {
  readonly code = "APPROVAL_NOT_FOUND" as const;
  readonly statusCode = 404;
  constructor(executionId: string, stepId: string) {
    super(`No approval request found for execution "${executionId}", step "${stepId}".`);
  }
}

export class ApprovalUnauthorizedError extends Error {
  readonly code = "APPROVAL_UNAUTHORIZED" as const;
  readonly statusCode = 403;
  constructor(userId: string) {
    super(`User "${userId}" is not listed as an approver for this step.`);
  }
}

export class ApprovalAlreadyDecidedError extends Error {
  readonly code = "APPROVAL_ALREADY_DECIDED" as const;
  readonly statusCode = 409;
  constructor(status: ApprovalStatus) {
    super(`Approval is already in terminal state: "${status}".`);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApprovalService(): ApprovalService {
  // Composite key `${executionId}:${stepId}` → approval record
  const store = new Map<string, ApprovalRecord>();

  function key(executionId: string, stepId: string): string {
    return `${executionId}:${stepId}`;
  }

  // -------------------------------------------------------------------------
  // requestApproval
  // -------------------------------------------------------------------------

  function requestApproval(
    executionId: string,
    stepId: string,
    approvers: string[],
    message: string | undefined,
    timeoutMs: number,
  ): ApprovalRecord {
    const k = key(executionId, stepId);

    // Idempotent: if a record already exists, return it unchanged.
    // This handles the case where the execution engine crashes and retries.
    const existing = store.get(k);
    if (existing !== undefined) return existing;

    const now = new Date();
    const record: ApprovalRecord = {
      executionId,
      stepId,
      approvers,
      message: message ?? null,
      status: "pending",
      requestedAt: now.toISOString(),
      decidedAt: null,
      decidedBy: null,
      decision: null,
      comment: null,
      timeoutAt: new Date(now.getTime() + timeoutMs).toISOString(),
    };

    store.set(k, record);
    return record;
  }

  // -------------------------------------------------------------------------
  // submitDecision
  // -------------------------------------------------------------------------

  function submitDecision(
    executionId: string,
    stepId: string,
    userId: string,
    decision: ApprovalDecision,
    comment?: string,
  ): ApprovalRecord {
    const k = key(executionId, stepId);
    const record = store.get(k);

    if (record === undefined) {
      throw new ApprovalNotFoundError(executionId, stepId);
    }

    // Guard against decisions after timeout — treat timed_out as already-decided.
    const isTerminal: boolean =
      record.status === "approved" ||
      record.status === "rejected" ||
      record.status === "timed_out";

    if (isTerminal) {
      throw new ApprovalAlreadyDecidedError(record.status);
    }

    // Only listed approvers may submit decisions. This is the security boundary:
    // the execution engine trusts this service's enforcement, not the HTTP layer.
    if (!record.approvers.includes(userId)) {
      throw new ApprovalUnauthorizedError(userId);
    }

    const updated: ApprovalRecord = {
      ...record,
      status: decision,
      decidedAt: new Date().toISOString(),
      decidedBy: userId,
      decision,
      comment: comment ?? null,
    };

    store.set(k, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // getApprovalStatus
  // -------------------------------------------------------------------------

  function getApprovalStatus(executionId: string, stepId: string): ApprovalRecord | null {
    const record = store.get(key(executionId, stepId));
    if (record === undefined) return null;

    // Lazily transition pending records to timed_out when the deadline has passed.
    // This keeps the clock logic in one place rather than scattered across callers.
    if (record.status === "pending" && new Date() > new Date(record.timeoutAt)) {
      const timedOut: ApprovalRecord = {
        ...record,
        status: "timed_out",
        decidedAt: record.timeoutAt,
      };
      store.set(key(executionId, stepId), timedOut);
      return timedOut;
    }

    return record;
  }

  // -------------------------------------------------------------------------
  // listPendingApprovals
  // -------------------------------------------------------------------------

  function listPendingApprovals(executionId: string): PendingApprovalView[] {
    const results: PendingApprovalView[] = [];

    for (const record of store.values()) {
      if (record.executionId !== executionId) continue;

      // Apply the same lazy timeout transition as getApprovalStatus.
      const current = getApprovalStatus(record.executionId, record.stepId);
      if (current === null || current.status !== "pending") continue;

      results.push({
        executionId: current.executionId,
        stepId: current.stepId,
        approvers: current.approvers,
        message: current.message,
        status: current.status,
        requestedAt: current.requestedAt,
        timeoutAt: current.timeoutAt,
      });
    }

    return results;
  }

  return {
    requestApproval,
    submitDecision,
    getApprovalStatus,
    listPendingApprovals,
  };
}
