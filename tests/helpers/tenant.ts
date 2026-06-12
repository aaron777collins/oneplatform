import { randomUUID } from "node:crypto";

export function newTenantId(): string {
  return randomUUID();
}
