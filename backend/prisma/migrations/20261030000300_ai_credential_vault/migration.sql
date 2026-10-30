-- Store BYOK credentials as authenticated ciphertext only. The AES-256-GCM key
-- is configured separately in the backend secret manager and never stored here.
ALTER TABLE "AiUserSetting"
  ADD COLUMN "credentialCiphertext" TEXT;
