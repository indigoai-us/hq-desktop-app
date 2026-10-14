/**
 * The cloud bot pane's tabs, in order. The tab bar, keyboard order and the
 * remembered tab all read this one list: adding a tab is one entry here.
 */

import type { Component } from "svelte";
import type {
  AgentControlApi,
  AgentControlChannelKind,
  AgentControlView,
  PlatformAdapter,
} from "@hq/platform";
import ChannelsTab from "./ChannelsTab.svelte";
import RoutinesTab from "./RoutinesTab.svelte";
import PersonaTab from "./PersonaTab.svelte";
import BrainTab from "./BrainTab.svelte";

/** What every tab is handed by the pane. */
export interface CloudTabProps {
  uid: string;
  control: AgentControlApi;
  view: AgentControlView;
  /** The box is offline: writes will be refused until it is back. */
  offline: boolean;
  /** Replace part of the view with what the box read back. */
  onview: (patch: Partial<AgentControlView>) => void;
  /** A write was refused because the box is offline. */
  onoffline: () => void;
  /** Start connecting a channel through the app's existing flow, when the host has one. */
  onconnect?: ((kind: AgentControlChannelKind) => void) | null;
  onopenurl?: ((url: string) => void) | null;
  adapter?: PlatformAdapter | null;
  companyUid?: string | null;
}

export interface CloudTabDef {
  id: string;
  label: string;
  component: Component<CloudTabProps>;
}

export const CLOUD_BOT_TABS: readonly CloudTabDef[] = [
  { id: "channels", label: "Channels", component: ChannelsTab },
  { id: "routines", label: "Routines", component: RoutinesTab },
  { id: "persona", label: "Persona", component: PersonaTab },
  { id: "brain", label: "Brain", component: BrainTab },
];

const lastTab = new Map<string, string>();

/** The tab this bot's pane was last left on in this session, or the first tab. */
export function rememberedTab(uid: string, tabs: readonly CloudTabDef[] = CLOUD_BOT_TABS): string {
  const id = lastTab.get(uid);
  return id && tabs.some((t) => t.id === id) ? id : (tabs[0]?.id ?? "");
}

export function rememberTab(uid: string, id: string): void {
  lastTab.set(uid, id);
}

/** For tests: forget every remembered tab. */
export function forgetRememberedTabs(): void {
  lastTab.clear();
}
