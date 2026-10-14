<script lang="ts">
  /**
   * Settings nav icons: Phosphor Regular from the shared registry. Billing
   * keeps its original line card until the registry gains CreditCard.
   */
  import RailIcon from "../common/button/RailIcon.svelte";
  import type { RailIconName } from "../common/button/rail-icons.js";

  interface Props {
    name:
      | "profile"
      | "public-profile"
      | "billing"
      | "companies"
      | "general"
      | "agents"
      | "bots"
      | "appearance"
      | "notifications"
      | "sync"
      | "meetings"
      | "updates";
  }
  let { name }: Props = $props();

  const ICONS: Record<Props["name"], RailIconName> = {
    billing: "credit-card",
    profile: "user",
    "public-profile": "globe",
    companies: "buildings",
    general: "settings",
    agents: "users",
    bots: "robot",
    appearance: "circle-half",
    notifications: "bell",
    sync: "arrows-clockwise",
    meetings: "calendar",
    updates: "download",
  };
</script>

<RailIcon name={ICONS[name]} size={14} />

