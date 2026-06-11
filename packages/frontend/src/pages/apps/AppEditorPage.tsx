import React from "react";
import { useParams } from "@tanstack/react-router";
export function AppEditorPage() {
  const { id } = useParams({ from: "/authenticated/apps/$id/edit" });
  return <main id="main-content" tabIndex={-1} className="flex-1 p-6"><h1 className="text-2xl font-semibold">Editor — App {id}</h1></main>;
}
