/**
 * DataQualityPage — platform-wide data quality dashboard (NCA-013).
 * Route: /ontology/data-quality
 *
 * Fetches quality metrics from GET /v1/ontology/quality, which returns an
 * overall score and per-entity quality summaries (null rate, field count, score).
 *
 * The backend /quality endpoint has not been implemented yet. A 404 response is
 * treated as "no data configured" rather than an error — the page renders an
 * empty state explaining that no checks are set up. This avoids console errors
 * and gives users actionable feedback instead of a broken UI.
 */
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { Badge } from "@/components/ui/badge.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { ShieldCheck, ShieldAlert } from "lucide-react";

// ---------------------------------------------------------------------------
// API / fallback types
// ---------------------------------------------------------------------------

interface EntityQualitySummary {
  entity: string;
  fieldCount: number;
  /** Average null rate across all fields (0–1) */
  nullRate: number;
  /** Overall quality score for this entity (0–100) */
  score: number;
}

interface QualityResponse {
  overallScore: number;
  entities: EntityQualitySummary[];
}

// ---------------------------------------------------------------------------
// Score visual helpers
// ---------------------------------------------------------------------------

/** Maps a 0–100 score to a color class and label for quick comprehension. */
function scoreVariant(score: number): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  if (score >= 90) return { label: "Excellent", variant: "default" };
  if (score >= 70) return { label: "Good",      variant: "secondary" };
  if (score >= 50) return { label: "Fair",       variant: "outline" };
  return              { label: "Poor",      variant: "destructive" };
}

function ScoreGauge({ score }: { score: number }) {
  const { label, variant } = scoreVariant(score);
  const circumference = 2 * Math.PI * 36; // radius = 36
  const dashOffset = circumference * (1 - score / 100);

  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        viewBox="0 0 100 100"
        className="h-28 w-28"
        role="img"
        aria-label={`Overall data quality score: ${score} out of 100`}
      >
        {/* Track */}
        <circle
          cx="50" cy="50" r="36"
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="8"
        />
        {/* Fill */}
        <circle
          cx="50" cy="50" r="36"
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 50 50)"
        />
        <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="22" fontWeight="700" fill="currentColor">
          {score}
        </text>
      </svg>
      <Badge variant={variant}>{label}</Badge>
      <p className="text-xs text-[var(--color-muted-foreground)]">Overall quality score</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DataQualityPage component
// ---------------------------------------------------------------------------

// Empty state shown when the quality endpoint returns 404 (not yet implemented).
function QualityNotConfigured() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-[var(--color-border)] p-12 text-center">
      <ShieldAlert
        className="h-10 w-10 text-[var(--color-muted-foreground)]"
        aria-hidden="true"
      />
      <div className="space-y-1">
        <p className="text-sm font-medium">No data quality checks configured</p>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Data quality reporting is not yet available. Quality checks will appear
          here once the feature is enabled on this platform.
        </p>
      </div>
    </div>
  );
}

export function DataQualityPage() {
  const client = useApiClient();

  const { data, isLoading } = useQuery({
    queryKey: ["data-quality"],
    queryFn: async ({ signal }) => {
      try {
        return await client.get<QualityResponse>("/v1/ontology/quality", undefined, { signal });
      } catch (err) {
        // 404 means the endpoint is not implemented yet — treat as "no data"
        // rather than propagating an error that would pollute the console.
        if (err instanceof ApiError && err.statusCode === 404) {
          return null;
        }
        throw err;
      }
    },
    retry: false,
  });

  // Unwrap the gateway envelope if present (some responses nest data under { data: ... })
  const qualityInner = (data as unknown as { data?: QualityResponse })?.data ?? data;

  // null means "endpoint returned 404 — feature not configured yet"
  const quality: QualityResponse | null = qualityInner ?? null;

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Data Quality"
        description="Overview of data completeness and quality across your entities."
        breadcrumbs={[
          { label: "Platform" },
          { label: "Ontology", href: "/ontology" },
          { label: "Data Quality" },
        ]}
      />

      <div className="p-6 space-y-8">
        {isLoading ? (
          /* Skeleton placeholders while the request is in-flight */
          <>
            <section aria-labelledby="quality-score-heading">
              <h2 id="quality-score-heading" className="mb-4 text-sm font-semibold">
                Platform quality score
              </h2>
              <div className="flex items-center gap-8 rounded-lg border border-[var(--color-border)] p-6">
                <Skeleton className="h-28 w-28 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-64" />
                  <Skeleton className="h-4 w-48" />
                </div>
              </div>
            </section>
            <section aria-labelledby="entity-quality-heading">
              <h2 id="entity-quality-heading" className="mb-4 text-sm font-semibold">
                Entity quality summary
              </h2>
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            </section>
          </>
        ) : quality === null ? (
          /* Endpoint not implemented yet — show a non-alarming empty state */
          <QualityNotConfigured />
        ) : (
          /* Real data from the API */
          <>
            {/* Overall score */}
            <section aria-labelledby="quality-score-heading">
              <h2 id="quality-score-heading" className="mb-4 text-sm font-semibold">
                Platform quality score
              </h2>
              <div className="flex items-center gap-8 rounded-lg border border-[var(--color-border)] p-6">
                <ScoreGauge score={quality.overallScore} />
                <div className="space-y-1 text-sm text-[var(--color-muted-foreground)]">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-[var(--color-primary)]" aria-hidden="true" />
                    <span>Scores above 90 indicate excellent data completeness.</span>
                  </div>
                  <p>The overall score is a weighted average of per-entity quality scores.</p>
                  <p>Improve scores by reducing null rates and adding field descriptions.</p>
                </div>
              </div>
            </section>

            {/* Per-entity quality table */}
            <section aria-labelledby="entity-quality-heading">
              <h2 id="entity-quality-heading" className="mb-4 text-sm font-semibold">
                Entity quality summary
              </h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entity</TableHead>
                    <TableHead className="w-24 text-right">Fields</TableHead>
                    <TableHead className="w-28 text-right">Null rate</TableHead>
                    <TableHead className="w-28 text-right">Score</TableHead>
                    <TableHead className="w-28">Rating</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quality.entities.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
                        No entity quality data available.
                      </TableCell>
                    </TableRow>
                  ) : (
                    quality.entities.map((row) => {
                      const { label, variant } = scoreVariant(row.score);
                      return (
                        <TableRow key={row.entity}>
                          <TableCell className="font-medium">{row.entity}</TableCell>
                          <TableCell className="text-right text-sm">{row.fieldCount}</TableCell>
                          <TableCell className="text-right text-sm">
                            {(row.nullRate * 100).toFixed(1)}%
                          </TableCell>
                          <TableCell className="text-right text-sm font-mono">{row.score}</TableCell>
                          <TableCell>
                            <Badge variant={variant}>{label}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
