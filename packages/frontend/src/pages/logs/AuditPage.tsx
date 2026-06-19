/**
 * AuditPage — audit log table with search and date range filter.
 *
 * Route: /logs/audit
 */
import * as React from "react";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { AuditLogTable } from "@/components/logs/AuditLogTable.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Button } from "@/components/ui/button.js";
import { X } from "lucide-react";

export function AuditPage() {
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  return (
    <div className="flex-1 p-6">
      <PageHeader
        title="Audit Log"
        description="Tamper-evident record of all platform actions."
        actions={
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="audit-from" className="sr-only">From date</Label>
              <Input
                id="audit-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-36"
                aria-label="Filter from date"
              />
            </div>
            <span className="text-[var(--color-muted-foreground)] text-sm">to</span>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="audit-to" className="sr-only">To date</Label>
              <Input
                id="audit-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-36"
                aria-label="Filter to date"
              />
            </div>
            {(from !== "" || to !== "") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setFrom(""); setTo(""); }}
                className="text-xs gap-1"
                aria-label="Clear date filters"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                Clear
              </Button>
            )}
          </div>
        }
      />

      <div className="mt-6">
        <AuditLogTable
          {...(from !== "" ? (() => {
            const d = new Date(from);
            return Number.isNaN(d.getTime()) ? {} : { from: d.toISOString() };
          })() : {})}
          {...(to !== "" ? (() => {
            const d = new Date(to + "T23:59:59");
            return Number.isNaN(d.getTime()) ? {} : { to: d.toISOString() };
          })() : {})}
        />
      </div>
    </div>
  );
}
