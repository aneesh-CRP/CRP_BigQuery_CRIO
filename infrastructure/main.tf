terraform {
  required_version = ">= 1.0.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_project" "project" {
  project_id = var.project_id
}

# ============================================================================
# API Services
# ============================================================================

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "aiplatform.googleapis.com",
    "sqladmin.googleapis.com",
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "secretmanager.googleapis.com",
    "vpcaccess.googleapis.com",
    "artifactregistry.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ============================================================================
# Artifact Registry
# ============================================================================

resource "google_artifact_registry_repository" "agent" {
  location      = var.region
  repository_id = var.app_name
  format        = "DOCKER"
  description   = "Docker images for ${var.app_name}"

  depends_on = [google_project_service.apis]
}

# ============================================================================
# Networking - VPC for Private Cloud SQL Access
# ============================================================================

resource "google_compute_network" "vpc" {
  name                    = "${var.app_name}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "subnet" {
  name          = "${var.app_name}-subnet"
  ip_cidr_range = "10.0.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id
}

# Private IP range for Cloud SQL
resource "google_compute_global_address" "private_ip_range" {
  name          = "${var.app_name}-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

# Private connection to Cloud SQL
resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_range.name]
  depends_on              = [google_project_service.apis]
}

# VPC Connector for Cloud Run to access Cloud SQL
resource "google_vpc_access_connector" "connector" {
  name          = "${var.app_name}-c"
  region        = var.region
  network       = google_compute_network.vpc.name
  ip_cidr_range = "10.8.0.0/28"
  depends_on    = [google_project_service.apis]
}

# ============================================================================
# Cloud SQL - PostgreSQL for Chat History & Sessions
# ============================================================================

resource "random_password" "db_password" {
  length  = 24
  special = false
}

resource "google_sql_database_instance" "chat_db" {
  name             = "${var.app_name}-db-${var.environment}"
  database_version = "POSTGRES_15"
  region           = var.region

  settings {
    tier = var.db_tier

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
    }

    backup_configuration {
      enabled = var.environment == "prod" ? true : false
    }
  }

  deletion_protection = var.environment == "prod" ? true : false
  depends_on          = [google_service_networking_connection.private_vpc_connection]
}

resource "google_sql_database" "chat_history" {
  name     = var.db_name
  instance = google_sql_database_instance.chat_db.name
}

resource "google_sql_user" "app_user" {
  name     = var.db_user
  instance = google_sql_database_instance.chat_db.name
  password = random_password.db_password.result
}

# ============================================================================
# Secret Manager - Database URL
# ============================================================================

resource "google_secret_manager_secret" "database_url" {
  secret_id = "${var.app_name}-database-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://${google_sql_user.app_user.name}:${random_password.db_password.result}@${google_sql_database_instance.chat_db.private_ip_address}:5432/${google_sql_database.chat_history.name}"
}

# Grant Cloud Run service account access to secret
resource "google_secret_manager_secret_iam_member" "cloud_run_access" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project_service_identity.cloud_run.email}"
}

resource "google_project_service_identity" "cloud_run" {
  provider = google-beta
  project  = var.project_id
  service  = "run.googleapis.com"
}

# ============================================================================
# Cloud Run - Single service (API + frontend)
# ============================================================================

locals {
  artifact_registry = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.agent.repository_id}"
  app_image         = var.app_image != "" ? var.app_image : "${local.artifact_registry}/app:v7"
}

resource "google_cloud_run_v2_service" "app" {
  name     = var.app_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    # Scale-to-zero with 1 min instance for low-latency
    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.app_image

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = var.region
      }

      env {
        name  = "GOOGLE_GENAI_USE_VERTEXAI"
        value = "1"
      }

      env {
        name  = "BIGQUERY_PROJECT_ID"
        value = var.bigquery_project_id != "" ? var.bigquery_project_id : var.project_id
      }

      env {
        name  = "BIGQUERY_DATASET_ID"
        value = var.bigquery_dataset_id
      }

      env {
        name  = "BIGQUERY_BILLING_PROJECT"
        value = var.bigquery_billing_project != "" ? var.bigquery_billing_project : var.project_id
      }

      env {
        name  = "BIGQUERY_LOCATION"
        value = var.bigquery_location
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.container_cpu
          memory = var.container_memory
        }
      }

      # Startup probe
      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 15
        period_seconds        = 10
        failure_threshold     = 6
        timeout_seconds       = 5
      }

      # Liveness probe
      liveness_probe {
        http_get {
          path = "/health"
        }
        period_seconds  = 30
        timeout_seconds = 3
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_version.database_url,
  ]
}

# ============================================================================
# IAM
# ============================================================================

# Control who can invoke the Cloud Run service.
# Set allowed_invokers = ["allUsers"] for public access,
# or specify individual users/groups for restricted access.
resource "google_cloud_run_service_iam_binding" "app_invoker" {
  location = google_cloud_run_v2_service.app.location
  service  = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  members  = var.allowed_invokers
}

# Grant Vertex AI access to the default compute service account
resource "google_project_iam_member" "vertex_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}

# ============================================================================
# Outputs
# ============================================================================

output "app_url" {
  value       = google_cloud_run_v2_service.app.uri
  description = "Cloud Run service URL"
}

output "artifact_registry" {
  value       = local.artifact_registry
  description = "Artifact Registry path for docker push"
}

output "database_instance" {
  value       = google_sql_database_instance.chat_db.name
  description = "Cloud SQL instance name"
}

output "database_connection_name" {
  value       = google_sql_database_instance.chat_db.connection_name
  description = "Cloud SQL connection name for Cloud SQL Proxy"
}
