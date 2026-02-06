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

data "google_project" "project" {
  project_id = "crio-468120"
}

resource "google_project_service" "run_api" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "ai_api" {
  service            = "aiplatform.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iap_api" {
  service            = "iap.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry_api" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "clinical_research_agent" {
  location      = "us-central1"
  repository_id = "clinical-research-agent"
  format        = "DOCKER"
  description   = "Docker images for the Clinical Research Agent"

  depends_on = [google_project_service.artifactregistry_api]
}

resource "google_cloud_run_v2_service" "backend" {
  name     = "clinical-research-backend"
  location = "us-central1"
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    containers {
      image = "us-central1-docker.pkg.dev/crio-468120/clinical-research-agent/backend:latest"

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = "crio-468120"
      }

      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = "us-central1"
      }

      env {
        name  = "GOOGLE_GENAI_USE_VERTEXAI"
        value = "1"
      }

      ports {
        container_port = 8080
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

resource "google_cloud_run_v2_service" "frontend" {
  name     = "clinical-research-frontend"
  location = "us-central1"
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    containers {
      image = "us-central1-docker.pkg.dev/crio-468120/clinical-research-agent/frontend:latest"

      env {
        name  = "BACKEND_URL"
        value = google_cloud_run_v2_service.backend.uri
      }

      ports {
        container_port = 8080
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

resource "google_cloud_run_service_iam_binding" "frontend_public" {
  location = google_cloud_run_v2_service.frontend.location
  service  = google_cloud_run_v2_service.frontend.name
  role     = "roles/run.invoker"
  members = [
    "allUsers",
  ]
}

# IAM - Backend accessible only by the frontend (and allUsers for now)
# TODO: Lock down to only the frontend service account
resource "google_cloud_run_service_iam_binding" "backend_public" {
  location = google_cloud_run_v2_service.backend.location
  service  = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  members = [
    "allUsers",
  ]
}

resource "google_project_iam_member" "vertex_ai_user" {
  project = "crio-468120"
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${data.google_project.project.number}-compute@developer.gserviceaccount.com"
}

resource "google_iap_client" "web_client" {
  display_name = "Clinical Research Agent Web Client"
  brand        = "projects/142405845774/brands/142405845774"

  depends_on = [google_project_service.iap_api]
}

output "backend_url" {
  value       = google_cloud_run_v2_service.backend.uri
  description = "Backend Cloud Run service URL"
}

output "frontend_url" {
  value       = google_cloud_run_v2_service.frontend.uri
  description = "Frontend Cloud Run service URL"
}

output "oauth_client_id" {
  value       = google_iap_client.web_client.client_id
  description = "OAuth 2.0 Client ID for the web application"
}

output "oauth_client_secret" {
  value       = google_iap_client.web_client.secret
  sensitive   = true
  description = "OAuth 2.0 Client Secret (keep this secure!)"
}

