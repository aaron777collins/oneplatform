import React from "react";
import { useParams } from "@tanstack/react-router";
export function PipelineBuilderPage() {
  const { id } = useParams({ from: "/authenticated/pipelines/$id/edit" });
  return <main id="main-content" tabIndex={-1} className="flex-1 p-6"><h1 className="text-2xl font-semibold">Edit Pipeline {id}</h1></main>;
}
