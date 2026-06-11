/**
 * SchemaInferencePanel — Casey's primary onboarding flow.
 *
 * The user uploads a CSV file. The frontend parses the first N rows and infers
 * column types. A preview table shows column names and detected types with
 * dropdowns to override the type before confirming.
 *
 * "Confirm" calls POST /api/v1/ontology with the inferred/overridden schema,
 * creating a new entity type from the CSV structure.
 *
 * The type inference is intentionally simple (client-side) — the first 200
 * rows are sampled to keep parsing fast. The server will re-validate when
 * creating the ontology entry.
 */
import * as React from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import type { FieldType } from "./FieldRow.js";
import { FIELD_TYPE_OPTIONS } from "./FieldRow.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InferredColumn {
  csvName: string;
  fieldName: string;
  detectedType: FieldType;
  /** Override chosen by the user; undefined means "use detectedType" */
  overrideType?: FieldType;
  sampleValues: string[];
}

export interface SchemaInferencePanelProps {
  onConfirm: (entityName: string, columns: InferredColumn[]) => void | Promise<void>;
  isConfirming?: boolean;
}

// ---------------------------------------------------------------------------
// Type inference helpers
// ---------------------------------------------------------------------------

const MAX_SAMPLE_ROWS = 200;

function inferColumnType(values: string[]): FieldType {
  const nonEmpty = values.filter((v) => v.trim().length > 0);
  if (nonEmpty.length === 0) return "string";

  // Boolean
  const boolTokens = new Set(["true", "false", "yes", "no", "1", "0"]);
  if (nonEmpty.every((v) => boolTokens.has(v.toLowerCase()))) return "boolean";

  // Integer
  if (nonEmpty.every((v) => /^-?\d+$/.test(v.trim()))) return "integer";

  // Number
  if (nonEmpty.every((v) => !isNaN(parseFloat(v)) && isFinite(parseFloat(v)))) return "number";

  // UUID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (nonEmpty.every((v) => uuidPattern.test(v.trim()))) return "uuid";

  // Date / datetime
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const datetimePattern = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
  if (nonEmpty.every((v) => datetimePattern.test(v.trim()))) return "datetime";
  if (nonEmpty.every((v) => datePattern.test(v.trim()))) return "date";

  return "string";
}

function csvToSlug(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^(\d)/, "_$1")
    .replace(/__+/g, "_");
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] => {
    const cols: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        cols.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur);
    return cols;
  };

  const firstLine = lines[0];
  const headers = firstLine !== undefined ? parseRow(firstLine) : [];
  const rows = lines
    .slice(1, MAX_SAMPLE_ROWS + 1)
    .map((l) => parseRow(l));

  return { headers, rows };
}

// ---------------------------------------------------------------------------
// SchemaInferencePanel component
// ---------------------------------------------------------------------------

export function SchemaInferencePanel({ onConfirm, isConfirming = false }: SchemaInferencePanelProps) {
  const [columns, setColumns] = React.useState<InferredColumn[] | null>(null);
  const [entityName, setEntityName] = React.useState("");
  const [parseError, setParseError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file === undefined) return;
    setParseError(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== "string") return;

      const { headers, rows } = parseCsv(text);
      if (headers.length === 0) {
        setParseError("CSV has no columns. Make sure the first row contains column headers.");
        setColumns(null);
        return;
      }

      const inferred: InferredColumn[] = headers.map((header, colIdx) => {
        const sampleValues = rows
          .map((row) => row[colIdx] ?? "")
          .slice(0, 5);
        const allValues = rows.map((row) => row[colIdx] ?? "");
        return {
          csvName: header,
          fieldName: csvToSlug(header),
          detectedType: inferColumnType(allValues),
          sampleValues,
        };
      });

      setColumns(inferred);

      // Default entity name from filename without extension
      const baseName = file.name.replace(/\.csv$/i, "");
      const pascalName = baseName
        .split(/[_\s-]+/)
        .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : ""))
        .join("");
      setEntityName(pascalName);
    };
    reader.onerror = () => setParseError("Failed to read file.");
    reader.readAsText(file);
  }

  function handleTypeOverride(columnIndex: number, newType: FieldType) {
    setColumns((prev) => {
      if (prev === null) return null;
      return prev.map((col, i) => {
        if (i !== columnIndex) return col;
        return { ...col, overrideType: newType };
      });
    });
  }

  async function handleConfirm() {
    if (columns === null) return;
    await onConfirm(entityName, columns);
  }

  return (
    <div className="space-y-4">
      {/* Upload zone */}
      <div
        className="flex flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed border-[var(--color-border)] bg-[var(--color-muted)]/20 p-8"
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-label="Upload CSV file"
      >
        <Upload className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
        <p className="text-sm font-medium">Click to upload CSV file</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          First row must be column headers. First 200 rows are sampled for type inference.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={handleFileChange}
          aria-label="CSV file input"
        />
      </div>

      {parseError !== null && (
        <p className="text-sm text-[var(--color-destructive)]" role="alert">
          {parseError}
        </p>
      )}

      {/* Schema preview */}
      {columns !== null && (
        <div className="space-y-4">
          {/* Entity name */}
          <div className="space-y-2">
            <Label htmlFor="inferred-entity-name">
              Entity type name
              <span className="ml-1 text-[var(--color-destructive)]" aria-hidden>*</span>
            </Label>
            <Input
              id="inferred-entity-name"
              value={entityName}
              onChange={(e) => setEntityName(e.target.value)}
              placeholder="e.g. CustomerRecord"
              className="max-w-xs"
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Must start with a capital letter, alphanumeric only.
            </p>
          </div>

          {/* Column table */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>CSV column</TableHead>
                <TableHead>Field name</TableHead>
                <TableHead className="w-36">Detected type</TableHead>
                <TableHead>Sample values</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {columns.map((col, i) => {
                const activeType = col.overrideType ?? col.detectedType;
                return (
                  <TableRow key={col.csvName}>
                    <TableCell className="font-mono text-xs">{col.csvName}</TableCell>
                    <TableCell className="font-mono text-xs text-[var(--color-muted-foreground)]">
                      {col.fieldName}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={activeType}
                        onValueChange={(v) => handleTypeOverride(i, v as FieldType)}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FIELD_TYPE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                              {opt.value === col.detectedType && " (detected)"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                      {col.sampleValues
                        .filter((v) => v.trim().length > 0)
                        .slice(0, 3)
                        .join(", ")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              {columns.length} columns detected
            </p>
            <Button
              onClick={() => void handleConfirm()}
              disabled={
                isConfirming ||
                entityName.trim().length === 0 ||
                !/^[A-Z][a-zA-Z0-9]*$/.test(entityName.trim())
              }
              aria-busy={isConfirming}
            >
              {isConfirming ? (
                <span className="flex items-center gap-2">
                  <span
                    className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                    aria-hidden
                  />
                  Creating entity…
                </span>
              ) : (
                "Confirm and create entity"
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
