# OnePlatform Multi-Region — Outputs
#
# Exposes endpoints, connection strings, and identifiers for each region.
# These outputs are consumed by CI/CD pipelines and operational scripts.

# ---------------------------------------------------------------------------
# Primary region
# ---------------------------------------------------------------------------

output "primary_region" {
  description = "AWS region of the primary deployment"
  value       = var.primary_region
}

output "primary_alb_dns" {
  description = "DNS name of the primary region's Application Load Balancer"
  value       = module.region_primary.alb_dns_name
}

output "primary_rds_endpoint" {
  description = "RDS endpoint for the primary PostgreSQL instance"
  value       = module.region_primary.rds_endpoint
  sensitive   = true
}

output "primary_rds_arn" {
  description = "ARN of the primary RDS instance (used for creating read replicas)"
  value       = module.region_primary.rds_arn
}

output "primary_redis_endpoint" {
  description = "ElastiCache Redis endpoint in the primary region"
  value       = module.region_primary.redis_endpoint
  sensitive   = true
}

output "primary_vpc_id" {
  description = "VPC ID in the primary region"
  value       = module.region_primary.vpc_id
}

output "primary_ecs_cluster_name" {
  description = "ECS cluster name in the primary region"
  value       = module.region_primary.ecs_cluster_name
}

# ---------------------------------------------------------------------------
# Secondary regions
# ---------------------------------------------------------------------------

output "secondary_regions" {
  description = "Map of secondary region names to their deployment details"
  value = {
    for region, mod in module.region_secondary : region => {
      alb_dns_name     = mod.alb_dns_name
      rds_endpoint     = mod.rds_endpoint
      redis_endpoint   = mod.redis_endpoint
      vpc_id           = mod.vpc_id
      ecs_cluster_name = mod.ecs_cluster_name
    }
  }
  sensitive = true
}

output "secondary_alb_dns_names" {
  description = "ALB DNS names for each secondary region"
  value       = { for region, mod in module.region_secondary : region => mod.alb_dns_name }
}

# ---------------------------------------------------------------------------
# Cross-region
# ---------------------------------------------------------------------------

output "platform_url" {
  description = "Public URL for the OnePlatform deployment"
  value       = "https://${var.domain}"
}

output "route53_zone_id" {
  description = "Route53 hosted zone ID used for DNS records"
  value       = data.aws_route53_zone.platform.zone_id
}

output "replication_mode" {
  description = "Multi-region replication mode in use"
  value       = var.replication_mode
}

output "all_region_endpoints" {
  description = "Summary of all region endpoints for operational use"
  value = merge(
    {
      (var.primary_region) = {
        role           = "primary"
        alb_dns        = module.region_primary.alb_dns_name
        rds_endpoint   = module.region_primary.rds_endpoint
        redis_endpoint = module.region_primary.redis_endpoint
      }
    },
    {
      for region, mod in module.region_secondary : region => {
        role           = var.replication_mode == "active-active" ? "primary" : "read-replica"
        alb_dns        = mod.alb_dns_name
        rds_endpoint   = mod.rds_endpoint
        redis_endpoint = mod.redis_endpoint
      }
    }
  )
  sensitive = true
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

output "secrets_arn" {
  description = "ARN of the Secrets Manager secret containing shared credentials"
  value       = aws_secretsmanager_secret.oneplatform.arn
}

# ---------------------------------------------------------------------------
# Connection strings (for operational scripts)
# ---------------------------------------------------------------------------

output "primary_database_url" {
  description = "PostgreSQL connection string for the primary region (use via pgbouncer in production)"
  value       = "postgres://postgres:${random_password.postgres_password.result}@${module.region_primary.rds_endpoint}:5432/oneplatform"
  sensitive   = true
}

output "primary_redis_url" {
  description = "Redis connection string for the primary region"
  value       = "redis://default:${random_password.redis_password.result}@${module.region_primary.redis_endpoint}:6379"
  sensitive   = true
}
