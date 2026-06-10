const PG_IDENTIFIER_REGEX = /^[a-z][a-z0-9_]*$/;

export function quotePgIdentifier(slug: string): string {
  if (!PG_IDENTIFIER_REGEX.test(slug)) {
    throw new Error(`Invalid PostgreSQL identifier: "${slug}"`);
  }
  return `"${slug.replace(/"/g, '""')}"`;
}

export function tenantSchemaName(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, "")}`;
}

const RESERVED_SLUGS = new Set(["bulk", "id", "migrations", "validate", "drafts", "mappings"]);

export function isReservedSlug(slug: string): boolean {
  return slug.startsWith("_") || RESERVED_SLUGS.has(slug);
}

export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+/, "")
    .replace(/_+$/g, "");
}
