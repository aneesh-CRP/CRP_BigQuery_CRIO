variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP region for resources"
  type        = string
  default     = "us-central1"
}

variable "app_name" {
  description = "Application name used for resource naming"
  type        = string
  default     = "bigquery-agent"
}

variable "environment" {
  description = "Environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "allowed_invokers" {
  description = "List of IAM members allowed to invoke Cloud Run (e.g., 'user:name@example.com', 'group:team@example.com'). Use ['allUsers'] for public access."
  type        = list(string)
  default     = [] # Intentionally empty — must be configured explicitly
}

# Database configuration
variable "db_tier" {
  description = "Cloud SQL instance tier"
  type        = string
  default     = "db-f1-micro"
}

variable "db_name" {
  description = "Database name"
  type        = string
  default     = "chat_history"
}

variable "db_user" {
  description = "Database user"
  type        = string
  default     = "app_user"
}

# Container image
variable "app_image" {
  description = "Container image (full path). Defaults to Artifact Registry."
  type        = string
  default     = ""
}

variable "container_cpu" {
  description = "CPU limit for Cloud Run container"
  type        = string
  default     = "1000m"
}

variable "container_memory" {
  description = "Memory limit for Cloud Run container"
  type        = string
  default     = "512Mi"
}

variable "max_instances" {
  description = "Maximum number of Cloud Run instances"
  type        = number
  default     = 5
}

# BigQuery configuration
variable "bigquery_project_id" {
  description = "GCP project containing the BigQuery dataset (defaults to project_id)"
  type        = string
  default     = ""
}

variable "bigquery_dataset_id" {
  description = "BigQuery dataset ID"
  type        = string
}

variable "bigquery_billing_project" {
  description = "GCP project for BigQuery billing (defaults to project_id)"
  type        = string
  default     = ""
}

variable "bigquery_location" {
  description = "BigQuery dataset location"
  type        = string
  default     = "US"
}
