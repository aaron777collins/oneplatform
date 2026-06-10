export interface EntityRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  version: number;
  description: string | null;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  deleted_at: Date | null;
}

export interface FieldRow {
  id: string;
  entity_id: string;
  tenant_id: string;
  name: string;
  slug: string;
  field_type: string;
  required: boolean;
  nullable: boolean;
  default_value: unknown;
  validation_rules: ValidationRule[];
  enum_values: string[] | null;
  array_item_type: string | null;
  ref_entity_id: string | null;
  is_indexed: boolean;
  is_unique: boolean;
  sort_order: number;
  system_generated: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ValidationRule {
  type: "min" | "max" | "minLength" | "maxLength" | "pattern" | "email" | "url";
  value?: number | string;
  message?: string;
}

export interface RelationshipRow {
  id: string;
  tenant_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  from_field_name: string;
  to_field_name: string | null;
  join_table_name: string | null;
  cascade_delete: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface MappingRuleRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  source_field_path: string;
  target_entity_id: string;
  target_field_id: string;
  transform_type: string;
  transform: string | null;
  is_active: boolean;
  priority: number;
  created_at: Date;
  updated_at: Date;
}

export interface MigrationRow {
  id: string;
  tenant_id: string;
  entity_id: string;
  from_version: number;
  to_version: number;
  change_type: string;
  is_breaking: boolean;
  change_plan: Record<string, unknown>;
  status: string;
  migration_job_id: string | null;
  union_view_name: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  error_details: Record<string, unknown> | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_at: Date;
}

export interface ShadowRegistryRow {
  id: string;
  migration_id: string;
  entity_type: string;
  batch_id: string;
  table_name: string;
  schema_name: string;
  row_count: number;
  batch_index: number;
  status: string;
  created_at: Date;
}

export interface MappingErrorRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  batch_id: string;
  raw_id: string;
  entity_type: string;
  error_fields: string[];
  error_details: Record<string, unknown>;
  raw_data: Record<string, unknown>;
  created_at: Date;
}

export interface DraftOntologyRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  inferred_schema: InferredSchema;
  status: string;
  sample_batch_id: string;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  confirmed_by: string | null;
}

export interface InferredSchema {
  entityType: string;
  fields: InferredField[];
  sampleCount: number;
}

export interface InferredField {
  path: string;
  suggestedSlug: string;
  inferredType: string;
  confidence: number;
  sampleValues: unknown[];
  nullRate: number;
}

// ---------------------------------------------------------------------------
// Input shapes for create / update operations
// ---------------------------------------------------------------------------

export interface CreateEntityData {
  tenant_id: string;
  name: string;
  slug: string;
  description?: string;
  is_public?: boolean;
  created_by: string;
}

export interface UpdateEntityData {
  name?: string;
  description?: string | null;
  is_public?: boolean;
}

export interface CreateFieldData {
  entity_id: string;
  tenant_id: string;
  name: string;
  slug: string;
  field_type: string;
  required?: boolean;
  nullable?: boolean;
  default_value?: unknown;
  validation_rules?: ValidationRule[];
  enum_values?: string[];
  array_item_type?: string;
  ref_entity_id?: string;
  is_indexed?: boolean;
  is_unique?: boolean;
  sort_order?: number;
  system_generated?: boolean;
}

export interface UpdateFieldData {
  name?: string;
  validation_rules?: ValidationRule[];
  is_indexed?: boolean;
  is_unique?: boolean;
  default_value?: unknown;
}

export interface CreateRelationshipData {
  tenant_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  from_field_name: string;
  to_field_name?: string;
  join_table_name?: string;
  cascade_delete?: boolean;
}

export interface CreateMappingRuleData {
  tenant_id: string;
  connector_id: string;
  source_field_path: string;
  target_entity_id: string;
  target_field_id: string;
  transform_type?: string;
  transform?: string;
  priority?: number;
}

export interface UpdateMappingRuleData {
  source_field_path?: string;
  transform_type?: string;
  transform?: string;
  is_active?: boolean;
  priority?: number;
}

export interface CreateMigrationData {
  tenant_id: string;
  entity_id: string;
  from_version: number;
  to_version: number;
  change_type: string;
  is_breaking: boolean;
  change_plan: Record<string, unknown>;
}

export interface CreateShadowRegistryData {
  migration_id: string;
  entity_type: string;
  batch_id: string;
  table_name: string;
  schema_name: string;
  row_count: number;
  batch_index: number;
}

export interface CreateMappingErrorData {
  tenant_id: string;
  connector_id: string;
  batch_id: string;
  raw_id: string;
  entity_type: string;
  error_fields: string[];
  error_details: Record<string, unknown>;
  raw_data: Record<string, unknown>;
}

export interface CreateDraftData {
  tenant_id: string;
  connector_id: string;
  inferred_schema: InferredSchema;
  sample_batch_id: string;
}
