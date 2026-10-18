import { mount } from "svelte";
import CompanyOutpostSignInPreview from "../../../packages/ui/src/company-outpost/CompanyOutpostSignInPreview.svelte";
import "../src/styles/design-system.css";
import "../../../packages/ui/src/home/tokens.css";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "dark" || theme === "light") {
  document.documentElement.dataset.forceTheme = theme;
}
mount(CompanyOutpostSignInPreview, {
  target: document.getElementById("app")!,
  props: { state: params.get("state") ?? "not-signed-in" },
});
