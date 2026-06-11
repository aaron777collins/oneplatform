import React from "react";
import { Link } from "@tanstack/react-router";
export function NotFoundPage() {
  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">Page not found</p>
      <Link to="/" className="text-primary underline">Go home</Link>
    </main>
  );
}
