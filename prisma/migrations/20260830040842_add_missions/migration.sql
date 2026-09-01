-- AlterTable
ALTER TABLE "users" ADD COLUMN     "xp_boost_expires_at" TIMESTAMP(3),
ADD COLUMN     "xp_from_missions" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "mission_progress" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mission_key" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mission_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_claims" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mission_key" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "reward_type" TEXT NOT NULL,
    "reward_value" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mission_progress_user_id_periodo_idx" ON "mission_progress"("user_id", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "mission_progress_user_id_mission_key_periodo_key" ON "mission_progress"("user_id", "mission_key", "periodo");

-- CreateIndex
CREATE INDEX "reward_claims_user_id_idx" ON "reward_claims"("user_id");

-- AddForeignKey
ALTER TABLE "mission_progress" ADD CONSTRAINT "mission_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_claims" ADD CONSTRAINT "reward_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
