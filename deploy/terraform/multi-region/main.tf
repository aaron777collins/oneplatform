# OnePlatform Multi-Region Terraform Configuration
#
# Provisions a multi-region deployment of OnePlatform on AWS with:
#   - VPC + subnets per region
#   - RDS PostgreSQL (primary + cross-region read replicas)
#   - ElastiCache Redis per region
#   - ECS Fargate cluster running all 9 OnePlatform services
#   - Application Load Balancer with health checks
#   - Route53 latency-based DNS records
#   - VPC peering between regions
#   - CloudWatch alarms for replication lag
#
# Usage:
#   terraform init
#   terraform plan -var='regions=["us-east-1","eu-west-1"]' \
#                  -var='primary_region=us-east-1'
#   terraform apply
#
# Ref: docs/MULTI-REGION-DEPLOYMENT.md

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state — uncomment and configure for production
  # backend "s3" {
  #   bucket         = "oneplatform-terraform-state"
  #   key            = "multi-region/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "oneplatform-terraform-locks"
  #   encrypt        = true
  # }
}

# ---------------------------------------------------------------------------
# Provider configuration — one per region
# ---------------------------------------------------------------------------

# Default provider (primary region)
provider "aws" {
  region = var.primary_region

  default_tags {
    tags = {
      Project     = "oneplatform"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Aliased providers for each additional region.
# Terraform does not support dynamic provider blocks, so we define the
# common secondary regions statically. The module instances only activate
# for regions listed in var.regions.
provider "aws" {
  alias  = "eu-west-1"
  region = "eu-west-1"

  default_tags {
    tags = {
      Project     = "oneplatform"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

provider "aws" {
  alias  = "ap-southeast-1"
  region = "ap-southeast-1"

  default_tags {
    tags = {
      Project     = "oneplatform"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ---------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

data "aws_route53_zone" "platform" {
  name         = var.domain
  private_zone = false
}

# ---------------------------------------------------------------------------
# Shared secrets
# ---------------------------------------------------------------------------

resource "random_password" "postgres_password" {
  length  = 32
  special = false
}

resource "random_password" "redis_password" {
  length  = 32
  special = false
}

resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "oneplatform" {
  name        = "oneplatform/${var.environment}/credentials"
  description = "OnePlatform shared credentials for multi-region deployment"
}

resource "aws_secretsmanager_secret_version" "oneplatform" {
  secret_id = aws_secretsmanager_secret.oneplatform.id
  secret_string = jsonencode({
    postgres_password = random_password.postgres_password.result
    redis_password    = random_password.redis_password.result
    jwt_secret        = random_password.jwt_secret.result
  })
}

# ---------------------------------------------------------------------------
# Per-region module instances
# ---------------------------------------------------------------------------

module "region_primary" {
  source = "./modules/region"

  region_name    = var.primary_region
  region_role    = "primary"
  environment    = var.environment
  domain         = var.domain
  base_url       = "https://${var.domain}"
  image_tag      = var.image_tag
  image_registry = var.image_registry

  vpc_cidr           = var.region_vpc_cidrs[var.primary_region]
  availability_zones = var.region_azs[var.primary_region]

  # Database
  db_instance_class     = var.db_instance_class
  db_allocated_storage  = var.db_allocated_storage
  db_password           = random_password.postgres_password.result
  db_multi_az           = true
  db_is_primary         = true
  db_source_region      = ""
  db_source_db_arn      = ""

  # Redis
  redis_node_type       = var.redis_node_type
  redis_num_cache_nodes = var.redis_num_cache_nodes
  redis_password        = random_password.redis_password.result

  # Services
  service_cpu           = var.service_cpu
  service_memory        = var.service_memory
  gateway_replicas      = var.gateway_replicas_primary
  service_replicas      = var.service_replicas_primary

  # Secrets
  secrets_arn = aws_secretsmanager_secret.oneplatform.arn
  jwt_secret  = random_password.jwt_secret.result

  # DNS
  route53_zone_id = data.aws_route53_zone.platform.zone_id

  # Peer regions for VPC peering
  peer_region_vpc_ids   = { for r in var.secondary_regions : r => module.region_secondary[r].vpc_id }
  peer_region_vpc_cidrs = { for r in var.secondary_regions : r => var.region_vpc_cidrs[r] }

  # OnePlatform-specific
  primary_gateway_url   = ""
  peer_gateway_urls     = { for r in var.secondary_regions : r => "https://${r}.internal.${var.domain}:3000" }

  tags = var.tags
}

module "region_secondary" {
  source   = "./modules/region"
  for_each = toset(var.secondary_regions)

  region_name    = each.value
  region_role    = var.replication_mode == "active-active" ? "primary" : "read-replica"
  environment    = var.environment
  domain         = var.domain
  base_url       = "https://${var.domain}"
  image_tag      = var.image_tag
  image_registry = var.image_registry

  vpc_cidr           = var.region_vpc_cidrs[each.value]
  availability_zones = var.region_azs[each.value]

  # Database — read replica of the primary
  db_instance_class     = var.db_instance_class
  db_allocated_storage  = var.db_allocated_storage
  db_password           = random_password.postgres_password.result
  db_multi_az           = false
  db_is_primary         = false
  db_source_region      = var.primary_region
  db_source_db_arn      = module.region_primary.rds_arn

  # Redis — independent instance per region
  redis_node_type       = var.redis_node_type
  redis_num_cache_nodes = var.redis_num_cache_nodes
  redis_password        = random_password.redis_password.result

  # Services — fewer replicas in secondary regions
  service_cpu           = var.service_cpu
  service_memory        = var.service_memory
  gateway_replicas      = var.gateway_replicas_secondary
  service_replicas      = var.service_replicas_secondary

  # Secrets
  secrets_arn = aws_secretsmanager_secret.oneplatform.arn
  jwt_secret  = random_password.jwt_secret.result

  # DNS
  route53_zone_id = data.aws_route53_zone.platform.zone_id

  # Peer regions for VPC peering (connect to primary)
  peer_region_vpc_ids   = { (var.primary_region) = module.region_primary.vpc_id }
  peer_region_vpc_cidrs = { (var.primary_region) = var.region_vpc_cidrs[var.primary_region] }

  # OnePlatform-specific
  primary_gateway_url   = "https://${var.primary_region}.internal.${var.domain}:3000"
  peer_gateway_urls     = { (var.primary_region) = "https://${var.primary_region}.internal.${var.domain}:3000" }

  tags = var.tags
}

# ---------------------------------------------------------------------------
# Cross-region VPC peering acceptance
# ---------------------------------------------------------------------------
# VPC peering connections are created by the region module in the requester
# region. The accepter region must accept them. This is handled within the
# module using the peer_region_vpc_ids map.

# ---------------------------------------------------------------------------
# Route53 latency-based DNS
# ---------------------------------------------------------------------------

resource "aws_route53_record" "platform_primary" {
  zone_id = data.aws_route53_zone.platform.zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = module.region_primary.alb_dns_name
    zone_id                = module.region_primary.alb_zone_id
    evaluate_target_health = true
  }

  set_identifier = var.primary_region
  latency_routing_policy {
    region = var.primary_region
  }
}

resource "aws_route53_record" "platform_secondary" {
  for_each = toset(var.secondary_regions)

  zone_id = data.aws_route53_zone.platform.zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = module.region_secondary[each.value].alb_dns_name
    zone_id                = module.region_secondary[each.value].alb_zone_id
    evaluate_target_health = true
  }

  set_identifier = each.value
  latency_routing_policy {
    region = each.value
  }
}

# ---------------------------------------------------------------------------
# Route53 health checks per region
# ---------------------------------------------------------------------------

resource "aws_route53_health_check" "primary" {
  fqdn              = module.region_primary.alb_dns_name
  port               = 443
  type               = "HTTPS"
  resource_path      = "/api/v1/healthz"
  failure_threshold  = 3
  request_interval   = 10

  tags = merge(var.tags, {
    Name   = "oneplatform-health-${var.primary_region}"
    Region = var.primary_region
  })
}

resource "aws_route53_health_check" "secondary" {
  for_each = toset(var.secondary_regions)

  fqdn              = module.region_secondary[each.value].alb_dns_name
  port               = 443
  type               = "HTTPS"
  resource_path      = "/api/v1/healthz"
  failure_threshold  = 3
  request_interval   = 10

  tags = merge(var.tags, {
    Name   = "oneplatform-health-${each.value}"
    Region = each.value
  })
}
