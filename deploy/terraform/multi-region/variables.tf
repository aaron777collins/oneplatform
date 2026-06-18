# OnePlatform Multi-Region — Input Variables
#
# Required variables have no default. Optional variables have sensible
# defaults matching the Medium tier from docs/CAPACITY-PLANNING.md.

# ---------------------------------------------------------------------------
# Region configuration
# ---------------------------------------------------------------------------

variable "primary_region" {
  description = "AWS region for the primary (read-write) deployment"
  type        = string
  default     = "us-east-1"
}

variable "secondary_regions" {
  description = "List of AWS regions for secondary (read-replica or standby) deployments"
  type        = list(string)
  default     = ["eu-west-1"]

  validation {
    condition     = length(var.secondary_regions) >= 1
    error_message = "At least one secondary region is required for multi-region deployment."
  }
}

variable "regions" {
  description = "Convenience variable — all regions (primary + secondary). Computed from primary_region and secondary_regions if not set."
  type        = list(string)
  default     = null
}

variable "replication_mode" {
  description = "Multi-region replication pattern: active-passive, read-local-write-primary, or active-active"
  type        = string
  default     = "read-local-write-primary"

  validation {
    condition     = contains(["active-passive", "read-local-write-primary", "active-active"], var.replication_mode)
    error_message = "replication_mode must be one of: active-passive, read-local-write-primary, active-active"
  }
}

variable "region_vpc_cidrs" {
  description = "VPC CIDR block per region. Must not overlap for VPC peering."
  type        = map(string)
  default = {
    "us-east-1"      = "10.0.0.0/16"
    "eu-west-1"      = "10.1.0.0/16"
    "ap-southeast-1" = "10.2.0.0/16"
  }
}

variable "region_azs" {
  description = "Availability zones per region (minimum 2 for HA)"
  type        = map(list(string))
  default = {
    "us-east-1"      = ["us-east-1a", "us-east-1b", "us-east-1c"]
    "eu-west-1"      = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
    "ap-southeast-1" = ["ap-southeast-1a", "ap-southeast-1b", "ap-southeast-1c"]
  }
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

variable "environment" {
  description = "Deployment environment: dev, staging, production"
  type        = string
  default     = "production"

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be one of: dev, staging, production"
  }
}

variable "domain" {
  description = "Public domain name for the platform (e.g. platform.example.com)"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]+[a-z0-9]$", var.domain))
    error_message = "domain must be a valid DNS name"
  }
}

# ---------------------------------------------------------------------------
# Container images
# ---------------------------------------------------------------------------

variable "image_registry" {
  description = "Docker image registry prefix (e.g. ghcr.io/myorg/oneplatform)"
  type        = string
  default     = "ghcr.io/oneplatform"
}

variable "image_tag" {
  description = "Docker image tag for all OnePlatform services"
  type        = string
  default     = "latest"
}

# ---------------------------------------------------------------------------
# Database (RDS PostgreSQL)
# ---------------------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class for PostgreSQL. See docs/CAPACITY-PLANNING.md for tier recommendations."
  type        = string
  default     = "db.r6g.large"
}

variable "db_allocated_storage" {
  description = "Initial allocated storage in GB for the RDS instance"
  type        = number
  default     = 100

  validation {
    condition     = var.db_allocated_storage >= 20
    error_message = "Minimum 20 GB storage for RDS PostgreSQL"
  }
}

# ---------------------------------------------------------------------------
# Redis (ElastiCache)
# ---------------------------------------------------------------------------

variable "redis_node_type" {
  description = "ElastiCache node type for Redis"
  type        = string
  default     = "cache.r6g.large"
}

variable "redis_num_cache_nodes" {
  description = "Number of cache nodes per region (1 for standalone, 2+ for replication group)"
  type        = number
  default     = 2
}

# ---------------------------------------------------------------------------
# ECS Fargate — service sizing
# ---------------------------------------------------------------------------

variable "service_cpu" {
  description = "CPU units (1024 = 1 vCPU) for each OnePlatform service task"
  type        = number
  default     = 512
}

variable "service_memory" {
  description = "Memory in MB for each OnePlatform service task"
  type        = number
  default     = 1024
}

variable "gateway_replicas_primary" {
  description = "Number of gateway service replicas in the primary region"
  type        = number
  default     = 3
}

variable "gateway_replicas_secondary" {
  description = "Number of gateway service replicas in each secondary region"
  type        = number
  default     = 2
}

variable "service_replicas_primary" {
  description = "Default replica count for non-gateway services in the primary region"
  type        = number
  default     = 2
}

variable "service_replicas_secondary" {
  description = "Default replica count for non-gateway services in each secondary region"
  type        = number
  default     = 1
}

# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

variable "tags" {
  description = "Additional tags applied to all resources"
  type        = map(string)
  default     = {}
}
