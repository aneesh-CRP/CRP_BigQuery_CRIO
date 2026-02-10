terraform {
  backend "gcs" {
    bucket = "crio-terraform-state"
    prefix = "bigquery-agent"
  }
}
