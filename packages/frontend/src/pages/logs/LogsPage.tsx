/**
 * LogsPage — full log viewer with service selector and level toggle.
 *
 * Route: /logs
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { LogViewer } from "@/components/logs/LogViewer.js";
import { useApiClient } from "@/lib/api-client.js";

interface ServiceOption {
  name: string;
  status: string;
}

export function LogsPage() {
  const client = useApiClient();
  const [selectedService, setSelectedService] = React.useState<string | undefined>(undefined);

  const servicesQuery = useQuery({
    queryKey: ["service-health"],
    queryFn: ({ signal }) =>
      client.get<{ data: ServiceOption[] }>("/v1/health/services", undefined, { signal }),
    staleTime: 5 * 60_000,
  });

  const services = servicesQuery.data?.data ?? [];

  return (
    <main id="main-content" tabIndex={-1} className="flex-1 p-6">
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
                {services.map((svc) => (
                  <SelectItem key={svc.name} value={svc.name}>
                    {svc.name}
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
    </main>
  );
}
