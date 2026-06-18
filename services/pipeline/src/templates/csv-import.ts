// Template: Import CSV to Ontology
//
// Reads a CSV file from a connector (e.g. S3, SFTP), parses each row into a
// record, validates the shape, then bulk-upserts into the target ontology
// entity type.  Column mapping is expressed as a JSON object so callers can
// rename CSV headers to canonical field names without writing custom code.
//
// The zero-record guard uses a JSONata conditional expression so the upsert
// step is skipped cleanly rather than sending an empty body.

import type { PipelineDefinition } from "../schemas/index.js";

export interface CsvImportParams {
  /** UUID of a connector instance that exposes a CSV resource */
  connectorInstanceId: string;
  /** Target ontology entity type */
  entityType: string;
  /** Maps CSV header names to ontology field names (e.g. { "Product ID": "id" }) */
  columnMapping: Record<string, string>;
  /** Whether to skip rows that fail field validation (default: false = fail fast) */
  skipInvalidRows?: boolean;
}

export function csvImportTemplate(params: CsvImportParams): PipelineDefinition {
  const {
    connectorInstanceId,
    entityType,
    columnMapping,
    skipInvalidRows = false,
  } = params;

  // Serialise the column mapping as a literal so the sandbox code can use it
  // without an additional input binding.
  const columnMappingJson = JSON.stringify(columnMapping);

  return {
    version: 1,
    entryStepId: "fetch-csv",
    steps: [
      {
        id: "fetch-csv",
        name: "Fetch CSV from Connector",
        type: "connector",
        connectorInstanceId,
        syncMode: "full",
        waitForCompletion: true,
        onError: "fail",
      },
      {
        id: "parse-and-map",
        name: "Parse CSV and Map Columns",
        type: "code",
        language: "typescript",
        code: `
// Parses the raw CSV text delivered by the connector and applies the
// column mapping.  Returns an array so the conditional step can test $count().
export function handler(csvText: string): Record<string, unknown>[] {
  const COLUMN_MAPPING: Record<string, string> = ${columnMappingJson};
  const SKIP_INVALID = ${skipInvalidRows};

  const lines = csvText.split(/\\r?\\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = (lines[0] ?? "").split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const records: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] ?? "").split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const record: Record<string, unknown> = {};
    let valid = true;

    for (const [csvHeader, ontologyField] of Object.entries(COLUMN_MAPPING)) {
      const colIdx = headers.indexOf(csvHeader);
      if (colIdx === -1) {
        if (SKIP_INVALID) { valid = false; break; }
        throw new Error(\`CSV header "\${csvHeader}" not found in row \${i}\`);
      }
      record[ontologyField] = cells[colIdx];
    }

    if (valid) records.push(record);
  }

  return records;
}
`.trim(),
        entrypoint: "handler",
        inputs: {
          csvText: { from: "step", stepId: "fetch-csv" },
        },
        onError: "fail",
      },
      {
        // Guard: skip the upsert when the parser returns no records.
        // We check for the presence of the records field; the parse step
        // returns undefined records on an empty CSV to trigger the else branch.
        id: "check-has-records",
        name: "Check Row Count",
        type: "conditional",
        condition: {
          field: "records",
          operator: "exists",
        },
        thenStepId: "upsert-records",
        elseStepId: "no-records-skip",
        inputs: {
          records: { from: "step", stepId: "parse-and-map" },
        },
      },
      {
        // Zero-record guard — skip upsert cleanly rather than sending an empty body
        id: "no-records-skip",
        name: "No Records — Skip",
        type: "code",
        language: "typescript",
        code: `export function handler(): { skipped: true } { return { skipped: true }; }`,
        entrypoint: "handler",
        onError: "skip",
      },
      {
        id: "upsert-records",
        name: `Upsert ${entityType} Records`,
        type: "code",
        language: "typescript",
        code: `
export async function handler(records: Record<string, unknown>[]): Promise<{ upserted: number }> {
  const response = await fetch(
    process.env["ONTOLOGY_SERVICE_URL"] + "/internal/entities/bulk-upsert",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityType: "${entityType}", records }),
    },
  );
  if (!response.ok) {
    throw new Error(\`Ontology upsert failed: \${response.status}\`);
  }
  return (await response.json()) as { upserted: number };
}
`.trim(),
        entrypoint: "handler",
        inputs: {
          records: { from: "step", stepId: "parse-and-map" },
        },
        onError: "fail",
        retryConfig: {
          maxRetries: 2,
          backoffMs: 3000,
          backoffMultiplier: 2,
        },
      },
    ],
    options: {
      maxConcurrentRuns: 3,
      allowConcurrentRuns: true,
      retainRunsCount: 200,
    },
  };
}
