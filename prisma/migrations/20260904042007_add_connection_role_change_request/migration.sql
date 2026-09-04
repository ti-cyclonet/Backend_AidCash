-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "pending_role" "ConnectionRole",
ADD COLUMN     "role_change_requested_by" TEXT;
