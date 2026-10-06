import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { SETUP_TOOL_OFFER_EVENT } from '@hq/platform';
import type { EmitDesktopTelemetryOptions } from './desktop-telemetry';
import { registerSetupToolOfferTelemetry } from './setup-tool-offer-telemetry';

describe('registerSetupToolOfferTelemetry', () => {
  it('forwards the card events to consent-gated desktop telemetry, with the tool and flags only', () => {
    const target = new EventTarget();
    const emit = vi.fn(async (_options: EmitDesktopTelemetryOptions) => undefined);
    const stop = registerSetupToolOfferTelemetry(emit, target as unknown as Window);

    target.dispatchEvent(new CustomEvent(SETUP_TOOL_OFFER_EVENT, { detail: { action: 'shown', tool: 'claude' } }));
    target.dispatchEvent(
      new CustomEvent(SETUP_TOOL_OFFER_EVENT, { detail: { action: 'continued', tool: 'claude', launched: true } }),
    );
    target.dispatchEvent(new CustomEvent(SETUP_TOOL_OFFER_EVENT, { detail: { action: 'keptHere', tool: 'codex' } }));
    target.dispatchEvent(new CustomEvent(SETUP_TOOL_OFFER_EVENT, { detail: { action: 'nope', tool: 'codex' } }));

    expect(emit.mock.calls.map((c) => c[0])).toEqual([
      { eventName: 'setup_tool_offer_shown', properties: { tool: 'claude' } },
      { eventName: 'setup_tool_offer_continued', properties: { tool: 'claude', launched: true } },
      { eventName: 'setup_tool_offer_kept_here', properties: { tool: 'codex' } },
    ]);

    stop();
    target.dispatchEvent(new CustomEvent(SETUP_TOOL_OFFER_EVENT, { detail: { action: 'shown', tool: 'claude' } }));
    expect(emit).toHaveBeenCalledTimes(3);
  });
});
