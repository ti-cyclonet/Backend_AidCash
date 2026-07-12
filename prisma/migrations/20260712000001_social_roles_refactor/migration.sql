-- CreateEnum
CREATE TYPE "ConnectionRole" AS ENUM ('FRIEND', 'FAMILY', 'PARTNER');

-- AlterTable: Connection — añadir campo role
ALTER TABLE "connections" ADD COLUMN "role" "ConnectionRole" NOT NULL DEFAULT 'FRIEND';

-- AlterTable: Debt — añadir co_owner_id para deudas conjuntas
ALTER TABLE "debts" ADD COLUMN "co_owner_id" TEXT;
ALTER TABLE "debts" ADD CONSTRAINT "debts_co_owner_id_fkey" FOREIGN KEY ("co_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Loan — añadir source_expense_id
ALTER TABLE "loans" ADD COLUMN "source_expense_id" TEXT;

-- CreateTable: SharedPocketMember (tabla relacional multiusuario)
CREATE TABLE "shared_pocket_members" (
    "id" TEXT NOT NULL,
    "shared_pocket_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_pocket_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shared_pocket_members_shared_pocket_id_user_id_key" ON "shared_pocket_members"("shared_pocket_id", "user_id");

-- AddForeignKey
ALTER TABLE "shared_pocket_members" ADD CONSTRAINT "shared_pocket_members_shared_pocket_id_fkey" FOREIGN KEY ("shared_pocket_id") REFERENCES "shared_pockets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared_pocket_members" ADD CONSTRAINT "shared_pocket_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing shared_pockets data to members table
INSERT INTO "shared_pocket_members" ("id", "shared_pocket_id", "user_id", "role")
SELECT gen_random_uuid(), id, user_a_id, 'owner' FROM "shared_pockets" WHERE user_a_id IS NOT NULL;

INSERT INTO "shared_pocket_members" ("id", "shared_pocket_id", "user_id", "role")
SELECT gen_random_uuid(), id, user_b_id, 'member' FROM "shared_pockets" WHERE user_b_id IS NOT NULL;

-- Drop old columns from shared_pockets (after migration)
ALTER TABLE "shared_pockets" DROP COLUMN "user_a_id";
ALTER TABLE "shared_pockets" DROP COLUMN "user_b_id";
