/**
 * Typed errors for the connected-accounts layer (the social/errors.ts
 * precedent — routes/actions map these onto user-visible states).
 */

/** A stale expectedVersion on a social_account write — the caller re-reads
 *  and re-applies (never force-writes). */
export class AccountVersionConflictError extends Error {
  constructor(accountId: string) {
    super(`social_account ${accountId}: version conflict — the account changed since you read it`);
    this.name = "AccountVersionConflictError";
  }
}

/** Linking requires both the provider API key and the encryption key —
 *  actions surface this message verbatim. */
export class AccountsNotConfiguredError extends Error {
  constructor(missing: "provider" | "encryption") {
    super(
      missing === "provider"
        ? "Account linking isn't configured — set UPLOAD_POST_API_KEY on the server."
        : "Account linking isn't configured — set SOCIAL_ACCOUNTS_ENC_KEY on the server (openssl rand -base64 32)."
    );
    this.name = "AccountsNotConfiguredError";
  }
}
