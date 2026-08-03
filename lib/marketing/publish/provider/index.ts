/**
 * Provider selection — the single indirection point (the video provider
 * index.ts precedent). Swapping to Postproxy (the named fallback) means one
 * new adapter file + this switch; nothing above the seam changes
 * (docs/social-accounts.md § Swapping providers).
 */

import type { SocialPublishProvider } from "./types";
import { createUploadPostProvider, isUploadPostConfigured } from "./uploadPostClient";

export function isPublishProviderConfigured(): boolean {
  return isUploadPostConfigured();
}

export function getSocialPublishProvider(): SocialPublishProvider {
  return createUploadPostProvider();
}
