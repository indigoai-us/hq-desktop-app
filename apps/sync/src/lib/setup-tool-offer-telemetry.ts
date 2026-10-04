import { SETUP_TOOL_OFFER_EVENT, setupToolOfferTelemetry } from '@hq/platform';
import { emitDesktopTelemetry, type EmitDesktopTelemetryOptions } from './desktop-telemetry';

/**
 * Forward the setup bot's coding-tool offer events from the chat UI to the
 * consent-gated desktop telemetry path. Only the tool's id and booleans are
 * sent (see `setupToolOfferTelemetry`). Returns the unsubscribe.
 */
export function registerSetupToolOfferTelemetry(
  emit: (options: EmitDesktopTelemetryOptions) => Promise<void> = emitDesktopTelemetry,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const handle = (event: Event): void => {
    const record = setupToolOfferTelemetry((event as CustomEvent<unknown>).detail);
    if (!record) return;
    void emit({ eventName: record.eventName, properties: record.properties });
  };
  target.addEventListener(SETUP_TOOL_OFFER_EVENT, handle);
  return () => target.removeEventListener(SETUP_TOOL_OFFER_EVENT, handle);
}
