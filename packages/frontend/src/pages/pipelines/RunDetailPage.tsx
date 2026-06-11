import React from "react";
import { useParams } from "@tanstack/react-router";
export function RunDetailPage() {
  const { runId } = useParams({ from: "/authenticated/pipeline-runs/$runId" });
  return <main id="main-content" tabIndex={-1} className="flex-1 p-6"><h1 className="text-2xl font-semibold">Run {runId}</h1></main>;
}
