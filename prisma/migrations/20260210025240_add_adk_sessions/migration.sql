-- CreateTable
CREATE TABLE "AdkSession" (
    "id" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" JSONB NOT NULL DEFAULT '{}',
    "lastUpdateTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdkSessionEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventData" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invocationId" TEXT,
    "author" TEXT,

    CONSTRAINT "AdkSessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdkSession_appName_userId_idx" ON "AdkSession"("appName", "userId");

-- CreateIndex
CREATE INDEX "AdkSessionEvent_sessionId_idx" ON "AdkSessionEvent"("sessionId");

-- CreateIndex
CREATE INDEX "AdkSessionEvent_sessionId_timestamp_idx" ON "AdkSessionEvent"("sessionId", "timestamp");

-- AddForeignKey
ALTER TABLE "AdkSessionEvent" ADD CONSTRAINT "AdkSessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AdkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
