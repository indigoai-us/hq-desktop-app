/** One key per New bot session, so a double-click or a retry makes one bot. */
export function newWizardIdempotencyKey(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `desktop-new-bot-${random}`;
}
