/**
 * UI entry point for plain-language HQ API errors (QA-080). The mapper lives
 * in @hq/platform so the adapters and every surface share one copy table.
 */
export {
  API_ERROR_COPY,
  classifyApiError,
  friendlyApiError,
  type ApiErrorKind,
} from "@hq/platform";
