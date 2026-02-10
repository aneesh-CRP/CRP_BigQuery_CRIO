#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy

echo "Checking required env vars..."
echo "DATABASE_URL is set: $(if [ -n "$DATABASE_URL" ]; then echo 'yes'; else echo 'no'; fi)"
echo "GOOGLE_CLOUD_PROJECT is set: $(if [ -n "$GOOGLE_CLOUD_PROJECT" ]; then echo 'yes'; else echo 'no'; fi)"
echo "GOOGLE_GENAI_USE_VERTEXAI is set: $(if [ -n "$GOOGLE_GENAI_USE_VERTEXAI" ]; then echo 'yes'; else echo 'no'; fi)"

echo "Starting server..."
exec node dist/server.js
