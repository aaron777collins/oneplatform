/**
 * Pipeline service benchmarks.
 *
 * Measures the overhead introduced by the execution engine itself — not the
 * external services it calls.  All HTTP fan-outs (Execution Service, Plugin
 * Service, Ingestion Service) are replaced by in-process async no-ops so the
 * numbers reflect the engine's routing and state-management cost.
 *
 * What is measured:
 *   - Step execution latency — per-step dispatch overhead (resolveInput + route)
 *   - Pipeline throughput — steps/sec for a linear N-step pipeline
 *   - Conditional branching overhead — evaluateCondition path cost
 *   - Sub-workflow overhead — parallel branch fan-out with Promise.all
 */

import { runBenchmark, type BenchmarkResult } from "./framework.js";
import type {
  Step,
  CodeStep,
  ConditionalStep,
  ParallelStep,
  ParallelBranch,
} from "../../services/pipeline/src/services/pipeline-service.js";

// ---------------------------------------------------------------------------
// Minimal mock step definitions
// ---------------------------------------------------------------------------

function makeCodeStep(id: string, index: number): CodeStep {
  return {
    id,
    name: `step-${index}`,
    type: "code",
    language: "javascript",
    code: 'return { result: input.value + 1 };',
    inputs: {
      value: { from: "literal", value: index },
    },
  };
}

function makeConditionalStep(
  id: string,
  thenStepId: string,
  elseStepId: string,
): ConditionalStep {
  return {
    id,
    name: `conditional-${id}`,
    type: "conditional",
    condition: {
      field: "value",
      operator: "eq",
      value: 42,
    },
    thenStepId,
    elseStepId,
  };
}

// ---------------------------------------------------------------------------
// In-process execution engine simulation
//
// We replicate the routing logic from execution-engine.ts without the actual
// HTTP calls.  This measures the cost of:
//   - Input resolution via resolveStepInput
//   - Type-narrowing dispatch (if step.type === "code" / "conditional" etc.)
//   - stepOutputs Map reads and writes
// ---------------------------------------------------------------------------

type StepOutput = { output: unknown; nextStepId?: string };

function resolveStepInput(
  step: Step,
  runInput: Record<string, unknown>,
  stepOutputs: Map<string, unknown>,
): Record<string, unknown> {
  if (step.inputs === undefined) return {};

  const resolved: Record<string, unknown> = {};
  for (const [fieldName, source] of Object.entries(step.inputs)) {
    if (source.from === "literal") {
      resolved[fieldName] = source.value;
    } else if (source.from === "pipeline.input") {
      resolved[fieldName] = runInput;
    } else {
      resolved[fieldName] = stepOutputs.get(source.stepId);
    }
  }
  return resolved;
}

function executeStepSync(
  step: Step,
  runInput: Record<string, unknown>,
  stepOutputs: Map<string, unknown>,
): StepOutput {
  const input = resolveStepInput(step, runInput, stepOutputs);

  if (step.type === "code") {
    // No actual code execution — measures dispatch overhead only.
    return { output: { result: (input["value"] as number ?? 0) + 1 } };
  }

  if (step.type === "conditional") {
    // evaluateCondition is synchronous in the real engine for the structured
    // condition variant; replicate the same synchronous evaluation here.
    const fieldValue = runInput[step.condition.field] ?? input[step.condition.field];
    const condResult = fieldValue === step.condition.value;
    const nextStepId = condResult ? step.thenStepId : step.elseStepId;
    if (nextStepId !== undefined) {
      return { output: { condition: condResult }, nextStepId };
    }
    return { output: { condition: condResult } };
  }

  if (step.type === "parallel") {
    // Sequential simulation of branch traversal (measures overhead, not I/O).
    const output: Record<string, unknown> = {};
    for (const branch of step.branches) {
      output[branch.id] = `branch-${branch.id}-done`;
    }
    return { output };
  }

  return { output: null };
}

function getNextStepIdFromMain(
  step: Step,
  steps: Step[],
  conditionalNext: string | undefined,
): string | null {
  if (step.type === "conditional" && conditionalNext !== undefined) {
    return conditionalNext;
  }
  const idx = steps.findIndex((s) => s.id === step.id);
  if (idx === -1 || idx === steps.length - 1) return null;
  return steps[idx + 1]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Benchmark: step execution latency (single code step, repeated)
// ---------------------------------------------------------------------------

async function stepExecutionLatencyBenchmark(): Promise<BenchmarkResult> {
  const step = makeCodeStep("step-1", 0);
  const runInput = { value: 10 };
  const stepOutputs = new Map<string, unknown>();

  return runBenchmark(
    "pipeline/step-execution-latency",
    () => {
      executeStepSync(step, runInput, stepOutputs);
    },
    { iterations: 10_000, warmupIterations: 500, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// Benchmark: pipeline throughput — steps/sec for a linear N-step pipeline
// ---------------------------------------------------------------------------

async function pipelineThroughputBenchmark(stepCount: number): Promise<BenchmarkResult> {
  const steps: Step[] = Array.from({ length: stepCount }, (_, i) =>
    makeCodeStep(`step-${i}`, i),
  );
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const runInput = { value: 0 };
  const entryStepId = steps[0]?.id ?? "step-0";

  return runBenchmark(
    `pipeline/throughput-${stepCount}-steps`,
    () => {
      const stepOutputs = new Map<string, unknown>();
      let currentStepId: string | null = entryStepId;

      while (currentStepId !== null) {
        const step = stepMap.get(currentStepId);
        if (step === undefined) break;

        const result = executeStepSync(step, runInput, stepOutputs);
        stepOutputs.set(step.id, result.output);
        currentStepId = getNextStepIdFromMain(step, steps, result.nextStepId);
      }
    },
    { iterations: 1_000, warmupIterations: 50, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// Benchmark: conditional branching overhead
// ---------------------------------------------------------------------------

async function conditionalBranchingBenchmark(): Promise<BenchmarkResult> {
  // Build a 10-step pipeline where every other step is a conditional that
  // always routes to the "then" branch.
  const steps: Step[] = [];
  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) {
      steps.push(makeCodeStep(`step-${i}`, i));
    } else {
      const thenId = `step-${Math.min(i + 1, 9)}`;
      const elseId = `step-${Math.min(i + 2, 9)}`;
      steps.push(makeConditionalStep(`step-${i}`, thenId, elseId));
    }
  }

  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const runInput = { value: 42 }; // matches the conditional's eq check
  const entryStepId = steps[0]?.id ?? "step-0";

  return runBenchmark(
    "pipeline/conditional-branching-overhead",
    () => {
      const stepOutputs = new Map<string, unknown>();
      let currentStepId: string | null = entryStepId;
      let safetyCount = 0;

      while (currentStepId !== null && safetyCount < 20) {
        const step = stepMap.get(currentStepId);
        if (step === undefined) break;

        const result = executeStepSync(step, runInput, stepOutputs);
        stepOutputs.set(step.id, result.output);
        currentStepId = getNextStepIdFromMain(step, steps, result.nextStepId);
        safetyCount++;
      }
    },
    { iterations: 2_000, warmupIterations: 100, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// Benchmark: sub-workflow (parallel branch) overhead
// ---------------------------------------------------------------------------

async function subWorkflowOverheadBenchmark(branchCount: number): Promise<BenchmarkResult> {
  const branches: ParallelBranch[] = Array.from(
    { length: branchCount },
    (_, i) => ({
      id: `branch-${i}`,
      entryStepId: `branch-${i}-step-0`,
      steps: [makeCodeStep(`branch-${i}-step-0`, i)],
    }),
  );

  const parallelStep: ParallelStep = {
    id: "parallel-1",
    name: "parallel-benchmark",
    type: "parallel",
    branches,
    waitMode: "all",
  };

  const runInput: Record<string, unknown> = {};
  const stepOutputs = new Map<string, unknown>();

  return runBenchmark(
    `pipeline/parallel-branch-overhead-${branchCount}-branches`,
    async () => {
      // Simulate parallel branch fan-out with Promise.all to measure the
      // scheduling overhead of concurrent step dispatch.
      await Promise.all(
        branches.map(async (branch) => {
          const branchStepMap = new Map(branch.steps.map((s) => [s.id, s]));
          let currentStepId: string | null = branch.entryStepId;

          while (currentStepId !== null) {
            const step = branchStepMap.get(currentStepId);
            if (step === undefined) break;

            const result = executeStepSync(step, runInput, stepOutputs);
            stepOutputs.set(step.id, result.output);
            // Branches have no cross-step links; terminate after each step.
            currentStepId = null;
          }
        }),
      );
    },
    { iterations: 1_000, warmupIterations: 50, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runPipelineBenchmarks(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  results.push(await stepExecutionLatencyBenchmark());
  results.push(await pipelineThroughputBenchmark(5));
  results.push(await pipelineThroughputBenchmark(25));
  results.push(await conditionalBranchingBenchmark());
  results.push(await subWorkflowOverheadBenchmark(4));
  results.push(await subWorkflowOverheadBenchmark(16));

  return results;
}
