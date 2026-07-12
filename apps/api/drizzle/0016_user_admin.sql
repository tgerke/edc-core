-- Account lifecycle: administrator-issued credentials (creation, password
-- reset) are temporary — the holder must set their own password before doing
-- anything else. Enforced server-side by the auth plugin's request gate.
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;
