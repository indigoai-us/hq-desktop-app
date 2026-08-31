// Synthetic pinned "#setup" support channel — thin re-export.
//
// The shared source of truth lives in @hq/ui (packages/ui/src/chat/
// setup-channel.ts) so the LIVE desktop shell (ChatSidebar/DesktopApp) and
// this classic messaging surface (MessagesShell/SetupChannelView) stay in
// lockstep. The @hq/ui `Channel` type is structurally compatible with this
// app's local `./channels` Channel, so `SETUP_CHANNEL` re-exports cleanly.
export {
  SETUP_CHANNEL_ID,
  SETUP_CHANNEL,
  SETUP_LAUNCH_COMMANDS,
  SETUP_WELCOME_MESSAGES,
  isSetupChannel,
  type SetupLaunchCommandKey,
  type SetupWelcomeLink,
  type SetupWelcomeMessage,
} from '@hq/ui';
