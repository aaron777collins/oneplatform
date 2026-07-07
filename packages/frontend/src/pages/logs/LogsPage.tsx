/**
 * LogsPage — full log viewer with service selector and level toggle.
 *
 * Route: /logs
 */
import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { LogViewer } from "@/components/logs/LogViewer.js";

const PLATFORM_SERVICES = [
  "gateway-service",
  "auth-service",
  "ingestion-service",
  "ontology-service",
  "pipeline-service",
  "execution-service",
  "app-service",
  "logging-service",
  "plugin-service",
];

export function LogsPage() {
  const [selectedService, setSelectedService] = React.useState<string | undefined>(undefined);

  return (
    <div className="flex-1 p-6">
      <PageHeader
        title="Logs"
        description="Unified log stream across all platform services."
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="service-select" className="sr-only">Filter by service</label>
            <Select
              value={selectedService ?? "all"}
              onValueChange={(v) => setSelectedService(v === "all" ? undefined : v)}
            >
              <SelectTrigger id="service-select" className="w-44">
                <SelectValue placeholder="All services" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All services</SelectItem>
                {PLATFORM_SERVICES.map((svc) => (
                  <SelectItem key={svc} value={svc}>
                    {svc}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <div className="mt-6">
        <LogViewer
          {...(selectedService !== undefined ? { service: selectedService } : {})}
          height={600}
        />
      </div>
    </div>
  );
}
