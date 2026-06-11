import React from "react";
import { useParams } from "@tanstack/react-router";
export function EntityDetailPage() {
  const { entityType } = useParams({ from: "/authenticated/ontology/$entityType" });
  return <main id="main-content" tabIndex={-1} className="flex-1 p-6"><h1 className="text-2xl font-semibold">Entity: {entityType}</h1></main>;
}
