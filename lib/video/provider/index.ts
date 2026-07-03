/**
 * Provider selection. There is one provider today (Mux); this indirection is the
 * single place a second provider would be chosen (e.g. by env or per-course), so
 * nothing else in the video stack references a concrete provider.
 */

import { muxProvider } from "./muxClient";
import type { VideoProvider } from "./types";

export function getVideoProvider(): VideoProvider {
  return muxProvider;
}

export type {
  ProviderAssetInfo,
  ProviderDirectUpload,
  ProviderUploadInfo,
  ProviderWebhookEvent,
  VideoProvider,
} from "./types";
export { VideoProviderError } from "./types";
