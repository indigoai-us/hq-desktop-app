// Where the CI-only base probe dispatch goes in the merge-base `main.rs`.
//
// Bases that carry the meet-native webdriver entrypoint have two `fn main()`s,
// and the webdriver one comes first but is not compiled into the menubar app.
// Injecting there leaves the probe flag unhandled, so the built app starts
// normally and never exits (the Windows base proof timed out this way).
const APP_MAIN = /#\[cfg\(not\(feature = "meet-native-webdriver"\)\)\]\r?\nfn main\(\) \{/;
const ANY_MAIN = /fn main\(\) \{/;

export function injectBaseProbeMain(mainSource, probeMain) {
  const match = mainSource.match(APP_MAIN) ?? mainSource.match(ANY_MAIN);
  if (!match || match.index === undefined) {
    throw new Error("base main source has no main-function insertion marker");
  }
  const end = match.index + match[0].length;
  return `${mainSource.slice(0, end)}\n${probeMain}${mainSource.slice(end)}`;
}
