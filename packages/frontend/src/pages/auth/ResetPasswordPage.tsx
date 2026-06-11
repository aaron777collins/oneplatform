import React from "react";
import { useParams } from "@tanstack/react-router";

export function ResetPasswordPage() {
  const { token } = useParams({ from: "/reset-password/$token" });
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md p-8">
        <h1 className="mb-6 text-2xl font-semibold">Set new password</h1>
        <input type="hidden" value={token} readOnly />
      </div>
    </main>
  );
}
