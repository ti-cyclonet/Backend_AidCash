-- Invitaciones por enlace (Social + misiones de referidos)
ALTER TABLE "users" ADD COLUMN "invited_by_id" TEXT;

CREATE TABLE "invite_links" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "role" "ConnectionRole" NOT NULL DEFAULT 'FRIEND',
    "usos" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invite_links_code_key" ON "invite_links"("code");
CREATE UNIQUE INDEX "invite_links_inviter_id_role_key" ON "invite_links"("inviter_id", "role");

ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
