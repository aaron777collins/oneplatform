// Template: Daily Data Export
//
// Queries an ontology entity type, serialises the result to the requested
// format (JSON or CSV), and posts it to a destination webhook.  The pipeline
// is designed to run on a schedule (e.g. nightly at 02:00 UTC); the caller is
// responsible for attaching a Schedule after instantiation.

import type { PipelineDefinition } from "../schemas/index.js";

export interface DailyExportParams {
  /** Ontology entity type to export */
  entityType: string;
  /** HTTPS URL that receives the exported payload via POST */
  destinationWebhookUrl: string;
  /** Output serialisation format */
  format?: "json" | "csv";
  /** Optional JSONata filter expression applied before export (e.g. "status = 'active'") */
  filterExpression?: string;
}

export function dailyExportTemplate(params: DailyExportParams): PipelineDefinition {
  const {
    entityType,
    destinationWebhookUrl,
    format = "json",
    filterExpression,
  } = params;

  // Encode the filter expression as a literal so the sandbox can use it without
  // an extra input binding; undefined becomes the string "undefined" which the
  // handler checks explicitly.
  const filterLiteral = filterExpression !== undefined
    ? JSON.stringify(filterExpression)
    : "undefined";

  return {
    version: 1,
    entryStepId: "query-ontology",
    steps: [
      {
        id: "query-ontology",
        name: `Query ${entityType} from Ontology`,
        type: "code",
        language: "typescript",
        code: `
export async function handler(): Promise<Record<string, unknown>[]> {
  const FILTER: string | undefined = ${filterLiteral};
  const url = new URL(
    process.env["ONTOLOGY_SERVICE_URL"] + "/internal/entities/query",
  );
  url.searchParams.set("entityType", "${entityType}");
  if (FILTER !== undefined) url.searchParams.set("filter", FILTER);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(\`Ontology query failed: \${response.status}\`);
  }
  const body = await response.json() as { data: Record<string, unknown>[] };
  return body.data;
}
`.trim(),
        entrypoint: "handler",
        onError: "fail",
        retryConfig: {
          maxRetries: 3,
          backoffMs: 5000,
          backoffMultiplier: 2,
        },
      },
      {
        id: "serialize-output",
        name: `Serialize to ${format.toUpperCase()}`,
        type: "code",
        language: "typescript",
        code: format === "csv"
          ? `
export function handler(records: Record<string, unknown>[]): string {
  if (records.length === 0) return "";
  const headers = Object.keys(records[0] ?? {});
  const escape = (v: unknown): string => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\\n")
      ? \`"\${s.replace(/"/g, '""')}"\`
      : s;
  };
  const rows = records.map((r) => headers.map((h) => escape(r[h])).join(","));
  return [headers.map(escape).join(","), ...rows].join("\\n");
}
`.trim()
          : `
export function handler(records: Record<string, unknown>[]): string {
  return JSON.stringify({ entityType: "${entityType}", exportedAt: new Date().toISOString(), count: records.length, data: records });
}
`.trim(),
        entrypoint: "handler",
        inputs: {
          records: { from: "step", stepId: "query-ontology" },
        },
        onError: "fail",
      },
      {
        id: "post-to-destination",
        name: "POST Export to Destination",
        type: "webhook",
        url: destinationWebhookUrl,
        method: "POST",
        headers: {
          "Content-Type": format === "csv" ? "text/csv" : "application/json",
          "X-Export-Entity": entityType,
        },
        body: { from: "step", stepId: "serialize-output" } as unknown,
        timeout: 60_000,
      },
    ],
    options: {
      // Daily exports run one at a time to avoid duplicate deliveries
      maxConcurrentRuns: 1,
      allowConcurrentRuns: false,
      retainRunsCount: 90,
    },
  };
}
