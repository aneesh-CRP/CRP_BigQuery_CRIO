# Configure GCS backend for Terraform state
# This stores state in an encrypted, versioned GCS bucket

terraform {
  backend "gcs" {
    bucket = "crio-terraform-state"  # Create this bucket first
    prefix = "bigquery-agent"
  }
}
