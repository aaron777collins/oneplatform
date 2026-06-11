import React from "react";
import { useParams } from "@tanstack/react-router";
export function PluginDetailPage() {
  const { id } = useParams({ from: "/authenticated/plugins/$id" });
  return <main id="main-content" tabIndex={-1} className="flex-1 p-6"><h1 className="text-2xl font-semibold">Plugin {id}</h1></main>;
}
