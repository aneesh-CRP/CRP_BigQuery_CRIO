terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
      version = "4.51.0"
    }
  }
}

provider "google" {
  project = "crio-468120"
  region  = "us-central1"
}

# Enable Cloud Run API
resource "google_project_service" "run_api" {
  service = "run.googleapis.com"
  disable_on_destroy = false
}

# Enable Vertex AI API
resource "google_project_service" "ai_api" {
    service = "aiplatform.googleapis.com"
    disable_on_destroy = false
}

# Cloud Run Service
resource "google_cloud_run_v2_service" "agent_service" {
  name     = "clinical-research-agent"
  location = "us-central1"
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    containers {
      image = "gcr.io/crio-468120/agent:latest" # Placeholder: Build and Push first
      
      env {
        name = "GOOGLE_CLOUD_PROJECT"
        value = "crio-468120"
      }
      
      env {
        name = "GOOGLE_GENAI_USE_VERTEXAI"
        value = "1"
      }
      
      resources {
        limits = {
          cpu    = "1000m"
          memory = "512Mi"
        }
      }
    }
  }
  
  depends_on = [google_project_service.run_api]
}

# Allow unauthenticated invocations (or restrict as needed)
resource "google_cloud_run_service_iam_binding" "default" {
  location = google_cloud_run_v2_service.agent_service.location
  service  = google_cloud_run_v2_service.agent_service.name
  role     = "roles/run.invoker"
  members = [
    "allUsers" # Change to specific users for private access
  ]
}

output "service_url" {
  value = google_cloud_run_v2_service.agent_service.uri
}

# ============================================================================
# OAuth 2.0 Configuration for User Authentication
# ============================================================================

# Enable IAP API (required for OAuth brand/client management)
resource "google_project_service" "iap_api" {
  service            = "iap.googleapis.com"
  disable_on_destroy = false
}

# Use existing OAuth Brand (consent screen) - already configured in the project
# Brand: projects/142405845774/brands/142405845774
# To create a new client under the existing brand, use TF import or gcloud

# OAuth 2.0 Client for the Web Application
resource "google_iap_client" "web_client" {
  display_name = "Clinical Research Agent Web Client"
  brand        = "projects/142405845774/brands/142405845774"
  
  depends_on = [google_project_service.iap_api]
}

# Output the client ID and secret (secret should be treated carefully!)
output "oauth_client_id" {
  value       = google_iap_client.web_client.client_id
  description = "OAuth 2.0 Client ID for the web application"
}

output "oauth_client_secret" {
  value       = google_iap_client.web_client.secret
  sensitive   = true
  description = "OAuth 2.0 Client Secret (keep this secure!)"
}

