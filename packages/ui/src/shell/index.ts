/** V2 windowed desktop shell (design source: hq-sync desktop-alt). */
export { default as DesktopApp } from "./DesktopApp.svelte";
export {
  FIXTURE_COMPANIES,
  FIXTURE_INITIAL_ROW,
  FIXTURE_PINS,
  FIXTURE_SEARCH_ROWS,
  FIXTURE_SETTINGS_PROFILE,
  createFixtureChatSidebarApi,
  createFixtureConversationApi,
  createFixtureNotificationsApi,
  fixtureBoardFor,
  fixtureChannelStatusFor,
  fixtureFilesFor,
  fixtureMessagesFor,
  fixtureReactionsFor,
  seedFixturePins,
} from "./fixtures.js";
