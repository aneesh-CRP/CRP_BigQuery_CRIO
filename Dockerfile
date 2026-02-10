# =============================================================================
# Stage 1: Build the server (backend)
# =============================================================================
FROM node:20-alpine AS server-builder
WORKDIR /app

# Install server dependencies
COPY package.json package-lock.json ./
COPY ag-ui-adk/package.json ag-ui-adk/package.json
RUN npm ci

# Generate Prisma client (DATABASE_URL not needed for generate, only for migrate)
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

# Build ag-ui-adk adapter
COPY ag-ui-adk ./ag-ui-adk/
RUN cd ag-ui-adk && npm run build

# Copy source and build server
COPY . .
RUN npm run build

# =============================================================================
# Stage 2: Build the client (frontend)
# =============================================================================
FROM node:20-alpine AS client-builder
WORKDIR /app/client

# Client build args — VITE_ vars are baked into the JS bundle at build time
ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_APP_NAME
ARG VITE_APP_DESCRIPTION
ARG VITE_APP_TAGLINE
ARG VITE_APP_BRAND_NAME
ARG VITE_APP_CHAT_TITLE
ARG VITE_APP_CHAT_INITIAL
ARG VITE_APP_ICON

# Install client dependencies
COPY client/package.json client/package-lock.json ./
RUN npm ci

# Copy client source and build
COPY client/ .
RUN npm run build

# =============================================================================
# Stage 3: Production image
# =============================================================================
FROM node:20-alpine
WORKDIR /app

# Copy startup script first (as root to set permissions)
COPY --from=server-builder /app/start.sh ./start.sh
RUN chmod +x start.sh && chown node:node start.sh

# Server artifacts
COPY --from=server-builder --chown=node:node /app/package.json ./
COPY --from=server-builder --chown=node:node /app/node_modules ./node_modules
COPY --from=server-builder --chown=node:node /app/dist ./dist
COPY --from=server-builder --chown=node:node /app/config.json ./config.json
COPY --from=server-builder --chown=node:node /app/schema.json ./schema.json
COPY --from=server-builder --chown=node:node /app/ag-ui-adk/dist ./ag-ui-adk/dist
COPY --from=server-builder --chown=node:node /app/ag-ui-adk/package.json ./ag-ui-adk/package.json
COPY --from=server-builder --chown=node:node /app/prisma ./prisma
COPY --from=server-builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=server-builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma

# Client build output — served by Express in production
COPY --from=client-builder --chown=node:node /app/client/dist ./client/dist

ENV NODE_ENV=production
EXPOSE 8080

# Switch to non-root user
USER node

CMD ["./start.sh"]
