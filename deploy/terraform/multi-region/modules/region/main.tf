# OnePlatform Per-Region Module
#
# Provisions all infrastructure for a single region:
#   - VPC with public + private subnets across availability zones
#   - RDS PostgreSQL (primary or cross-region read replica)
#   - ElastiCache Redis with auth
#   - ECS Fargate cluster with all 9 OnePlatform services + Caddy
#   - Application Load Balancer with TLS termination
#   - VPC peering connections to peer regions
#   - CloudWatch alarms for replication lag and service health
#
# This module is instantiated once per region by the root main.tf.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "region_name" {
  description = "AWS region name (e.g. us-east-1)"
  type        = string
}

variable "region_role" {
  description = "Role of this region: primary, read-replica, or standby"
  type        = string
}

variable "environment" {
  type = string
}

variable "domain" {
  type = string
}

variable "base_url" {
  type = string
}

variable "image_tag" {
  type = string
}

variable "image_registry" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "availability_zones" {
  type = list(string)
}

# Database
variable "db_instance_class" {
  type = string
}

variable "db_allocated_storage" {
  type = number
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "db_multi_az" {
  type = bool
}

variable "db_is_primary" {
  description = "Whether this region hosts the primary RDS instance (true) or a read replica (false)"
  type        = bool
}

variable "db_source_region" {
  description = "Source region for cross-region read replica. Empty for primary."
  type        = string
  default     = ""
}

variable "db_source_db_arn" {
  description = "ARN of the source RDS instance for cross-region read replica. Empty for primary."
  type        = string
  default     = ""
}

# Redis
variable "redis_node_type" {
  type = string
}

variable "redis_num_cache_nodes" {
  type = number
}

variable "redis_password" {
  type      = string
  sensitive = true
}

# Services
variable "service_cpu" {
  type = number
}

variable "service_memory" {
  type = number
}

variable "gateway_replicas" {
  type = number
}

variable "service_replicas" {
  type = number
}

# Secrets
variable "secrets_arn" {
  type = string
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

# DNS
variable "route53_zone_id" {
  type = string
}

# Peering
variable "peer_region_vpc_ids" {
  description = "Map of peer region name to VPC ID for VPC peering"
  type        = map(string)
  default     = {}
}

variable "peer_region_vpc_cidrs" {
  description = "Map of peer region name to VPC CIDR for route table entries"
  type        = map(string)
  default     = {}
}

# OnePlatform
variable "primary_gateway_url" {
  description = "URL of the primary region's gateway (empty for primary region)"
  type        = string
  default     = ""
}

variable "peer_gateway_urls" {
  description = "Map of peer region name to gateway URL"
  type        = map(string)
  default     = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------

locals {
  name_prefix = "op-${var.environment}-${var.region_name}"

  # OnePlatform service definitions — name, port, cpu override, memory override
  services = {
    gateway = {
      port     = 3000
      replicas = var.gateway_replicas
      cpu      = var.service_cpu * 2  # Gateway gets double CPU
      memory   = var.service_memory * 2
      env_extra = {
        ONTOLOGY_SERVICE_URL  = "http://localhost:3001"
        INGESTION_SERVICE_URL = "http://localhost:3002"
        AUTH_SERVICE_URL      = "http://localhost:3003"
        PIPELINE_SERVICE_URL  = "http://localhost:3004"
        EXECUTION_SERVICE_URL = "http://localhost:3005"
        APP_SERVICE_URL       = "http://localhost:3006"
        LOGGING_SERVICE_URL   = "http://localhost:3007"
        PLUGIN_SERVICE_URL    = "http://localhost:3008"
        OP_GLOBAL_RATE_LIMIT  = "10000"
      }
    }
    auth = {
      port     = 3000
      replicas = var.service_replicas
      cpu      = var.service_cpu
      memory   = var.service_memory
      env_extra = {}
    }
    ingestion = {
      port     = 3000
      replicas = var.service_replicas
      cpu      = var.service_cpu
      memory   = var.service_memory * 2  # Ingestion is memory-heavy
      env_extra = {
        OP_INGESTION_BATCH_SIZE    = "1000"
        OP_LARGE_SYNC_CONCURRENCY  = "3"
      }
    }
    ontology = {
      port     = 3000
      replicas = var.service_replicas
      cpu      = var.service_cpu
      memory   = var.service_memory
      env_extra = {}
    }
    pipeline = {
      port     = 3000
      replicas = var.service_replicas
      cpu      = var.service_cpu * 2  # Pipeline is CPU-heavy during execution
      memory   = var.service_memory * 2
      env_extra = {}
    }
    execution = {
      port     = 3000
      replicas = var.service_replicas
      cpu      = var.service_cpu
      memory   = var.service_memory * 2  # Sandbox execution needs memory
      env_extra = {}
    }
    app = {
      port     = 3000
      replicas = var.service_replicas
      cpu      = var.service_cpu
      memory   = var.service_memory
      env_extra = {}
    }
    logging = {
      port     = 3000
      replicas = var.service_replicas
      cpu      = var.service_cpu
      memory   = var.service_memory
      env_extra = {}
    }
    plugin = {
      port     = 3000
      replicas = var.service_replicas
      cpu      = var.service_cpu
      memory   = var.service_memory
      env_extra = {}
    }
  }

  common_env = {
    NODE_ENV              = "production"
    OP_REGION             = var.region_name
    OP_REGION_ROLE        = var.region_role
    OP_BASE_URL           = var.base_url
    OP_PRIMARY_GATEWAY_URL = var.primary_gateway_url
  }

  region_tags = merge(var.tags, {
    Region     = var.region_name
    RegionRole = var.region_role
  })
}

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-vpc"
  })
}

# Public subnets (ALB, NAT Gateway)
resource "aws_subnet" "public" {
  count = length(var.availability_zones)

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-public-${var.availability_zones[count.index]}"
    Tier = "public"
  })
}

# Private subnets (ECS tasks, RDS, ElastiCache)
resource "aws_subnet" "private" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 100)
  availability_zone = var.availability_zones[count.index]

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-private-${var.availability_zones[count.index]}"
    Tier = "private"
  })
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-igw"
  })
}

# NAT Gateway (one per AZ for HA)
resource "aws_eip" "nat" {
  count  = length(var.availability_zones)
  domain = "vpc"

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-nat-eip-${count.index}"
  })
}

resource "aws_nat_gateway" "main" {
  count = length(var.availability_zones)

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-nat-${count.index}"
  })

  depends_on = [aws_internet_gateway.main]
}

# Route tables
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  count = length(var.availability_zones)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count = length(var.availability_zones)

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-private-rt-${count.index}"
  })
}

resource "aws_route_table_association" "private" {
  count = length(var.availability_zones)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ---------------------------------------------------------------------------
# VPC Peering
# ---------------------------------------------------------------------------

resource "aws_vpc_peering_connection" "peer" {
  for_each = var.peer_region_vpc_ids

  vpc_id      = aws_vpc.main.id
  peer_vpc_id = each.value
  peer_region = each.key
  auto_accept = false

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-peering-to-${each.key}"
  })
}

# Add routes to peer VPCs in private route tables
resource "aws_route" "to_peer" {
  for_each = var.peer_region_vpc_cidrs

  count                     = length(var.availability_zones)
  route_table_id            = aws_route_table.private[0].id
  destination_cidr_block    = each.value
  vpc_peering_connection_id = aws_vpc_peering_connection.peer[each.key].id
}

# ---------------------------------------------------------------------------
# Security Groups
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name_prefix = "${local.name_prefix}-alb-"
  vpc_id      = aws_vpc.main.id
  description = "ALB security group — allows HTTPS from the internet"

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP (redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-alb-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "ecs" {
  name_prefix = "${local.name_prefix}-ecs-"
  vpc_id      = aws_vpc.main.id
  description = "ECS tasks security group — allows traffic from ALB and within VPC"

  # Allow traffic from ALB
  ingress {
    description     = "From ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Allow inter-service communication within VPC
  ingress {
    description = "Inter-service"
    from_port   = 3000
    to_port     = 3010
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  # Allow traffic from peer VPCs (cross-region service calls)
  dynamic "ingress" {
    for_each = var.peer_region_vpc_cidrs
    content {
      description = "From peer region ${ingress.key}"
      from_port   = 3000
      to_port     = 3010
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-ecs-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "rds" {
  name_prefix = "${local.name_prefix}-rds-"
  vpc_id      = aws_vpc.main.id
  description = "RDS security group — allows PostgreSQL from ECS and peer regions"

  # Allow from ECS tasks
  ingress {
    description     = "PostgreSQL from ECS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  # Allow from peer regions (for streaming replication)
  dynamic "ingress" {
    for_each = var.peer_region_vpc_cidrs
    content {
      description = "PostgreSQL replication from ${ingress.key}"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-rds-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "redis" {
  name_prefix = "${local.name_prefix}-redis-"
  vpc_id      = aws_vpc.main.id
  description = "ElastiCache Redis security group — allows access from ECS tasks"

  ingress {
    description     = "Redis from ECS"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-redis-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# RDS PostgreSQL
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnet"
  subnet_ids = aws_subnet.private[*].id

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-db-subnet"
  })
}

resource "aws_db_parameter_group" "postgres16" {
  name   = "${local.name_prefix}-pg16"
  family = "postgres16"

  # Replication parameters — needed for primary to allow cross-region replicas
  parameter {
    name  = "rds.logical_replication"
    value = "1"
  }

  parameter {
    name  = "max_wal_senders"
    value = "10"
  }

  parameter {
    name  = "wal_keep_size"
    value = "4096"  # 4 GB in MB
  }

  parameter {
    name  = "max_connections"
    value = "200"
  }

  # Performance tuning
  parameter {
    name  = "shared_buffers"
    value = "{DBInstanceClassMemory/4}"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "effective_cache_size"
    value = "{DBInstanceClassMemory*3/4}"
  }

  parameter {
    name  = "work_mem"
    value = "16384"  # 16 MB
  }

  tags = local.region_tags
}

# Primary RDS instance (only created when db_is_primary = true)
resource "aws_db_instance" "primary" {
  count = var.db_is_primary ? 1 : 0

  identifier     = "${local.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 4  # Autoscaling up to 4x
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "oneplatform"
  username = "postgres"
  password = var.db_password

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.postgres16.name

  backup_retention_period = 14
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"

  # Enable Performance Insights for query-level monitoring
  performance_insights_enabled = true
  performance_insights_retention_period = 7

  # Enable deletion protection in production
  deletion_protection = var.environment == "production"
  skip_final_snapshot = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${local.name_prefix}-final-snapshot" : null

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-postgres-primary"
  })
}

# Cross-region read replica (only created when db_is_primary = false)
resource "aws_db_instance" "replica" {
  count = var.db_is_primary ? 0 : 1

  identifier     = "${local.name_prefix}-postgres"
  instance_class = var.db_instance_class

  replicate_source_db = var.db_source_db_arn

  storage_type      = "gp3"
  storage_encrypted = true

  # Read replicas inherit the source's engine, version, and database name.
  # Do not set engine, engine_version, db_name, username, or password.

  multi_az               = false
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.postgres16.name

  performance_insights_enabled = true
  performance_insights_retention_period = 7

  # Read replica can be promoted to standalone on failover
  # No backup settings needed — backups come from the primary

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-postgres-replica"
  })
}

# ---------------------------------------------------------------------------
# ElastiCache Redis
# ---------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis-subnet"
  subnet_ids = aws_subnet.private[*].id

  tags = local.region_tags
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${local.name_prefix}-redis"
  description          = "OnePlatform Redis — ${var.region_name} (${var.region_role})"

  node_type            = var.redis_node_type
  num_cache_clusters   = var.redis_num_cache_nodes
  port                 = 6379

  # Enable encryption
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_password

  # Automatic failover requires 2+ nodes
  automatic_failover_enabled = var.redis_num_cache_nodes >= 2
  multi_az_enabled           = var.redis_num_cache_nodes >= 2

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  # Engine
  engine               = "redis"
  engine_version       = "7.1"
  parameter_group_name = "default.redis7"

  # Maintenance
  maintenance_window    = "sun:05:00-sun:06:00"
  snapshot_window       = "02:00-03:00"
  snapshot_retention_limit = 7

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-redis"
  })
}

# ---------------------------------------------------------------------------
# ECS Cluster
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-ecs-cluster"
  })
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# IAM role for ECS task execution (pulling images, writing logs)
resource "aws_iam_role" "ecs_execution" {
  name = "${local.name_prefix}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.region_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow ECS to read secrets from Secrets Manager
resource "aws_iam_role_policy" "ecs_secrets" {
  name = "${local.name_prefix}-ecs-secrets"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [var.secrets_arn]
    }]
  })
}

# IAM role for ECS tasks (application-level permissions)
resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.region_tags
}

# CloudWatch log group for all services
resource "aws_cloudwatch_log_group" "services" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 30

  tags = local.region_tags
}

# ---------------------------------------------------------------------------
# ECS Services — one task definition and service per OnePlatform service
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "service" {
  for_each = local.services

  family                   = "${local.name_prefix}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = each.key
    image     = "${var.image_registry}/${each.key}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = each.value.port
      protocol      = "tcp"
    }]

    environment = [
      for k, v in merge(local.common_env, each.value.env_extra, {
        SERVICE_NAME = "${each.key}-service"
        PORT         = tostring(each.value.port)
      }) : {
        name  = k
        value = v
      }
    ]

    secrets = [
      {
        name      = "OP_DATABASE_PASSWORD"
        valueFrom = "${var.secrets_arn}:postgres_password::"
      },
      {
        name      = "OP_REDIS_PASSWORD"
        valueFrom = "${var.secrets_arn}:redis_password::"
      },
      {
        name      = "OP_JWT_SECRET"
        valueFrom = "${var.secrets_arn}:jwt_secret::"
      }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services.name
        "awslogs-region"        = var.region_name
        "awslogs-stream-prefix" = each.key
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:${each.value.port}/healthz || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }

    # Container hardening
    readonlyRootFilesystem = true
    linuxParameters = {
      capabilities = {
        drop = ["ALL"]
      }
    }

    mountPoints = [{
      sourceVolume  = "tmp"
      containerPath = "/tmp"
      readOnly      = false
    }]
  }])

  volume {
    name = "tmp"
  }

  tags = merge(local.region_tags, {
    Service = each.key
  })
}

resource "aws_ecs_service" "service" {
  for_each = local.services

  name            = "${local.name_prefix}-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = each.value.replicas
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  # Only register the gateway with the ALB
  dynamic "load_balancer" {
    for_each = each.key == "gateway" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.gateway.arn
      container_name   = "gateway"
      container_port   = 3000
    }
  }

  # Allow service to stabilize before marking unhealthy
  health_check_grace_period_seconds = each.key == "gateway" ? 60 : 0

  # Rolling deployment
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = merge(local.region_tags, {
    Service = each.key
  })

  depends_on = [aws_lb_listener.https]
}

# ---------------------------------------------------------------------------
# Application Load Balancer
# ---------------------------------------------------------------------------

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = var.environment == "production"

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-alb"
  })
}

resource "aws_lb_target_group" "gateway" {
  name        = "${local.name_prefix}-gateway-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 10
    path                = "/healthz"
    matcher             = "200"
  }

  # Deregistration delay — allow in-flight requests to complete
  deregistration_delay = 30

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-gateway-tg"
  })
}

# ACM certificate for TLS
resource "aws_acm_certificate" "main" {
  domain_name       = var.domain
  validation_method = "DNS"

  subject_alternative_names = [
    "*.${var.domain}"
  ]

  tags = merge(local.region_tags, {
    Name = "${local.name_prefix}-cert"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]

  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# HTTPS listener
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }

  tags = local.region_tags
}

# HTTP → HTTPS redirect
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = local.region_tags
}

# ---------------------------------------------------------------------------
# CloudWatch Alarms
# ---------------------------------------------------------------------------

# RDS replication lag alarm (only for read replicas)
resource "aws_cloudwatch_metric_alarm" "rds_replication_lag" {
  count = var.db_is_primary ? 0 : 1

  alarm_name          = "${local.name_prefix}-rds-replication-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ReplicaLag"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 30  # 30 seconds

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.replica[0].identifier
  }

  alarm_description = "PostgreSQL replication lag exceeds 30 seconds in ${var.region_name}"
  alarm_actions     = []  # Add SNS topic ARN for notifications

  tags = local.region_tags
}

# ECS service unhealthy alarm (one per service)
resource "aws_cloudwatch_metric_alarm" "ecs_service_health" {
  for_each = local.services

  alarm_name          = "${local.name_prefix}-${each.key}-unhealthy"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.service[each.key].name
  }

  alarm_description = "${each.key} has 0 running tasks in ${var.region_name}"
  alarm_actions     = []  # Add SNS topic ARN

  tags = local.region_tags
}

# ALB 5xx error rate alarm
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name_prefix}-alb-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 50  # More than 50 5xx errors per minute

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }

  alarm_description = "ALB 5xx error rate is high in ${var.region_name}"
  alarm_actions     = []  # Add SNS topic ARN

  tags = local.region_tags
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "vpc_id" {
  value = aws_vpc.main.id
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "alb_zone_id" {
  value = aws_lb.main.zone_id
}

output "rds_endpoint" {
  value = var.db_is_primary ? aws_db_instance.primary[0].endpoint : aws_db_instance.replica[0].endpoint
}

output "rds_arn" {
  value = var.db_is_primary ? aws_db_instance.primary[0].arn : aws_db_instance.replica[0].arn
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}
