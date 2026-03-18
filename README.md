# Clinical Research BigQuery Agent

An AI-powered agent that helps users query clinical research data in BigQuery using natural language. Built with Google ADK, CopilotKit, and Google Cloud.

## Features

- 🔐 **User-Level Authentication**: Users sign in with Google OAuth, queries run with their BigQuery permissions (RLS)
- 🤖 **AI-Powered Queries**: Natural language to SQL using Gemini models via Google ADK
- 💬 **Chat Interface**: CopilotKit-powered responsive chat UI
- 🏗️ **Infrastructure as Code**: Terraform configuration for GCP resources

---

## Project Structure

```
bigquery-agent/
├── server.mts              # Express server with CopilotKit + ADK integration
├── agent.ts                # Root ADK agent (clinical research orchestrator)
├── config.json             # Project settings & AI grounding domain knowledge
├── schema.json             # BigQuery table schema definitions
│
├── agents/
│   └── sql_agent.ts        # SQL specialist sub-agent
│
├── tools/
│   └── bigquery.ts         # BigQuery tools (list_tables, execute_query, etc.)
│
├── client/                 # React frontend (Vite)
│   ├── src/App.tsx         # Main app with Google OAuth login
│   └── .env.example        # OAuth client ID template
│
├── infrastructure/         # Terraform IaC
│   ├── main.tf             # Cloud Run, OAuth, API services
│   └── backend.tf          # GCS remote state configuration
│
├── tests/
│   ├── verify_queries.ts   # Query verification scripts
│   └── verify_server.sh    # Server health checks
│
├── Dockerfile              # Container build for Cloud Run
├── package.json            # Dependencies and scripts
└── tsconfig.json           # TypeScript configuration
```

---

## Quick Start

### Prerequisites

- Node.js 20+
- Google Cloud SDK (`gcloud`) authenticated
- Access to a GCP project with BigQuery and Vertex AI

### 1. Install Dependencies

```bash
npm install
cd client && npm install && cd ..
```

### 2. Configure Environment

```bash
# Backend (.env)
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_GENAI_USE_VERTEXAI=1

# Frontend (client/.env) - see client/.env.example
VITE_GOOGLE_CLIENT_ID=your-oauth-client-id.apps.googleusercontent.com
```

### 3. Configure OAuth (Manual Step)

> ⚠️ Google Cloud doesn't support programmatic OAuth origin configuration.

1. Go to [Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create OAuth 2.0 Client ID → Web Application
3. Add **Authorized JavaScript origins**: `http://localhost:5173`
4. Add **Authorized redirect URIs**: `http://localhost:5173`
5. Copy Client ID to `client/.env`

### 4. Authenticate with Google Cloud

Vertex AI requires application default credentials. Run these once (and again whenever your credentials expire):

```bash
gcloud auth login
gcloud auth application-default login
gcloud auth application-default set-quota-project crio-468120
```

### 5. Run Locally

#### Option A: Docker Compose (recommended)

```bash
docker-compose up --build
```

Open http://localhost:5173 and sign in with Google.

#### Option B: Without Docker

```bash
# Terminal 1: Backend (development)
npm run dev

# Terminal 2: Frontend
cd client && npm run dev
```

Open http://localhost:5173 and sign in with Google.

---

## Infrastructure

Terraform files are in `infrastructure/`. State is stored in GCS for security.

### First-Time Setup

```bash
# Create the state bucket (once per project)
gcloud storage buckets create gs://crio-terraform-state \
    --location=us-central1 \
    --uniform-bucket-level-access

# Initialize Terraform
cd infrastructure
terraform init
terraform apply
```

### What Gets Created

- Cloud Run service for the agent
- IAP API enabled
- OAuth client (note: origins must be configured manually)

---

## Security Model

| Component | Authentication |
|-----------|----------------|
| Vertex AI (LLM) | Application Default Credentials (service account) |
| BigQuery (Data) | User's OAuth token → Row-Level Security enforced |

This means:
- Any user can chat with the agent
- But they only see data they're authorized to access in BigQuery

---

## Development

```bash
# Type check
npx tsc --noEmit

# Run ADK dev tools (CLI mode)
npm run cli
```

---

**Note:**  
- Use `npm run dev` for backend development (hot reload, TypeScript source).
- Use `npm start` for production (runs compiled JavaScript, e.g. in Docker/Cloud Run).

---

## Deployment (Cloud Run)

### Prerequisites

1. Authenticate Docker with Artifact Registry (one-time):

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```

2. Create an Artifact Registry repository (one-time):

```bash
gcloud artifacts repositories create clinical-research-agent \
    --repository-format=docker \
    --location=us-central1 \
    --project=crio-468120
```

3. Grant the Cloud Run service account Vertex AI access (one-time):

```bash
gcloud projects add-iam-policy-binding crio-468120 \
    --member="serviceAccount:YOUR_SERVICE_ACCOUNT_EMAIL" \
    --role="roles/aiplatform.user"
```

### Build and Push Images

> **Note:** Cloud Run requires `linux/amd64` images. If you're on Apple Silicon (M1/M2/M3), you must include the `--platform` flag or the container will fail to start.

```bash
# Backend (from project root)
docker build --platform linux/amd64 -t us-central1-docker.pkg.dev/crio-468120/clinical-research-agent/backend:latest .
docker push us-central1-docker.pkg.dev/crio-468120/clinical-research-agent/backend:latest

# Frontend (from project root)
docker build --platform linux/amd64 -t us-central1-docker.pkg.dev/crio-468120/clinical-research-agent/frontend:latest ./client
docker push us-central1-docker.pkg.dev/crio-468120/clinical-research-agent/frontend:latest
```

### Deploy to Cloud Run

```bash
# 1. Deploy backend
gcloud run deploy clinical-research-backend \
    --image=us-central1-docker.pkg.dev/crio-468120/clinical-research-agent/backend:latest \
    --region=us-central1 \
    --project=crio-468120 \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=crio-468120,GOOGLE_CLOUD_LOCATION=us-central1,GOOGLE_GENAI_USE_VERTEXAI=1" \
    --allow-unauthenticated \
    --port=8080 \
    --memory=512Mi

# 2. Deploy frontend (replace BACKEND_URL with the URL from step 1)
gcloud run deploy clinical-research-frontend \
    --image=us-central1-docker.pkg.dev/crio-468120/clinical-research-agent/frontend:latest \
    --region=us-central1 \
    --project=crio-468120 \
    --set-env-vars="BACKEND_URL=https://clinical-research-backend-xxxxx-uc.a.run.app" \
    --allow-unauthenticated \
    --port=8080 \
    --memory=256Mi
```

### Post-Deploy: Update OAuth Origins

Add the frontend Cloud Run URL to your OAuth client in [Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials):

- **Authorized JavaScript origins**: `https://your-frontend-url.a.run.app`
- **Authorized redirect URIs**: `https://your-frontend-url.a.run.app`
