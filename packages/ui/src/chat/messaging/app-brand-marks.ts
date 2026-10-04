/**
 * The bundled brand marks of the apps most likely to appear on an integration
 * card, keyed by the app's website domain.
 *
 * A card's logo is drawn in this order: a bundled mark from here, else the
 * generic app glyph (ConnectionCardIcon.svelte). A bundled mark needs no
 * network and no image policy, so the apps on this list have their real logo
 * the moment the card draws, inside the Tauri webview as much as in a browser.
 * There is no remote image: the app's image policy names one remote origin
 * (the marketplace assets host, see avatars/csp-image-src.ts), and a domain a
 * bot writes in a message must never make the webview call a third party.
 * An app that is not on this list shows the generic glyph, never a made-up
 * logo.
 *
 * The paths and brand colours come from the `simple-icons` package (CC0 1.0).
 * Each path is drawn in a 24x24 viewBox. simple-icons has no Salesforce, no
 * Microsoft marks (Teams, Outlook), no Firecrawl, Twilio, LinkedIn, Attio,
 * Amplitude, Segment or DocuSign: those apps show the generic glyph. The Slack
 * mark was in simple-icons up to 15.x and is not in 16.x; its 15.0.0 path is
 * bundled here so the Slack card and the Connect Slack modal draw the real
 * mark.
 *
 * Nothing here comes from the bot: a domain is looked up in this table, and
 * the table is the app's own.
 */

import {
  si1password,
  siAirtable,
  siAlgolia,
  siAnthropic,
  siAsana,
  siAuth0,
  siBasecamp,
  siBitbucket,
  siBox,
  siBrave,
  siBrevo,
  siCaldotcom,
  siCalendly,
  siClerk,
  siClickup,
  siCloudflare,
  siCoda,
  siDatabricks,
  siDatadog,
  siDiscord,
  siDropbox,
  siElevenlabs,
  siFacebook,
  siFigma,
  siFirebase,
  siGithub,
  siGitlab,
  siGmail,
  siGoogle,
  siGoogleads,
  siGoogleanalytics,
  siGooglecalendar,
  siGooglecloud,
  siGoogledocs,
  siGoogledrive,
  siGooglemeet,
  siGooglesheets,
  siGrafana,
  siGusto,
  siHubspot,
  siHuggingface,
  siInstagram,
  siIntercom,
  siJira,
  siLinear,
  siLoom,
  siMailchimp,
  siMiro,
  siMixpanel,
  siMongodb,
  siN8n,
  siNetlify,
  siNotion,
  siOkta,
  siPagerduty,
  siPaypal,
  siPerplexity,
  siPosthog,
  siQuickbooks,
  siReddit,
  siResend,
  siRetool,
  siSentry,
  siShopify,
  siSnowflake,
  siSquare,
  siStripe,
  siSupabase,
  siTelegram,
  siTodoist,
  siTrello,
  siTypeform,
  siVercel,
  siWebflow,
  siWhatsapp,
  siWise,
  siX,
  siXero,
  siYoutube,
  siZapier,
  siZendesk,
  siZoho,
  siZoom,
} from "simple-icons";

/** One brand mark: a 24x24 path, the brand's colour, and the brand's name. */
export interface BrandMark {
  /** The brand's name as the icon set spells it, e.g. "Google Drive". */
  title: string;
  /** The brand colour, six hex digits, no `#`. */
  hex: string;
  /** The mark's SVG path data, in a `0 0 24 24` viewBox. */
  path: string;
}

/**
 * Slack's mark, the single-colour form, from simple-icons 15.0.0 (CC0 1.0).
 * Slack's brand colour is aubergine, `#4A154B`.
 */
export const SLACK_MARK: BrandMark = {
  title: "Slack",
  hex: "4A154B",
  path:
    "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
};

type SimpleIcon = { title: string; hex: string; path: string };

function mark(icon: SimpleIcon): BrandMark {
  return { title: icon.title, hex: icon.hex, path: icon.path };
}

/**
 * The marks by normalized domain (see `normalizeConnectDomain`: lower case,
 * no `www.` or `mcp.`, subdomains kept). An app's product host and its
 * company host both appear when a bot might name either.
 */
const MARKS: Readonly<Record<string, BrandMark>> = {
  "slack.com": SLACK_MARK,
  "gmail.com": mark(siGmail),
  "mail.google.com": mark(siGmail),
  "drive.google.com": mark(siGoogledrive),
  "calendar.google.com": mark(siGooglecalendar),
  "meet.google.com": mark(siGooglemeet),
  "docs.google.com": mark(siGoogledocs),
  "sheets.google.com": mark(siGooglesheets),
  "notion.so": mark(siNotion),
  "notion.com": mark(siNotion),
  "github.com": mark(siGithub),
  "linear.app": mark(siLinear),
  "hubspot.com": mark(siHubspot),
  "figma.com": mark(siFigma),
  "atlassian.com": mark(siJira),
  "atlassian.net": mark(siJira),
  "jira.com": mark(siJira),
  "asana.com": mark(siAsana),
  "zoom.us": mark(siZoom),
  "zoom.com": mark(siZoom),
  "dropbox.com": mark(siDropbox),
  "stripe.com": mark(siStripe),
  "trello.com": mark(siTrello),
  "airtable.com": mark(siAirtable),
  "intercom.com": mark(siIntercom),
  "intercom.io": mark(siIntercom),
  "zendesk.com": mark(siZendesk),
  // Google itself: a Google product that is not listed above draws the G.
  "google.com": mark(siGoogle),
  "analytics.google.com": mark(siGoogleanalytics),
  "ads.google.com": mark(siGoogleads),
  "cloud.google.com": mark(siGooglecloud),
  "firebase.google.com": mark(siFirebase),
  "youtube.com": mark(siYoutube),
  // Engineering.
  "sentry.io": mark(siSentry),
  "gitlab.com": mark(siGitlab),
  "bitbucket.org": mark(siBitbucket),
  "vercel.com": mark(siVercel),
  "netlify.com": mark(siNetlify),
  "cloudflare.com": mark(siCloudflare),
  "supabase.com": mark(siSupabase),
  "supabase.co": mark(siSupabase),
  "mongodb.com": mark(siMongodb),
  "snowflake.com": mark(siSnowflake),
  "databricks.com": mark(siDatabricks),
  "datadoghq.com": mark(siDatadog),
  "grafana.com": mark(siGrafana),
  "pagerduty.com": mark(siPagerduty),
  "algolia.com": mark(siAlgolia),
  "auth0.com": mark(siAuth0),
  "okta.com": mark(siOkta),
  "clerk.com": mark(siClerk),
  "1password.com": mark(si1password),
  "retool.com": mark(siRetool),
  "n8n.io": mark(siN8n),
  "zapier.com": mark(siZapier),
  // Product and analytics.
  "mixpanel.com": mark(siMixpanel),
  "posthog.com": mark(siPosthog),
  // Work and planning.
  "calendly.com": mark(siCalendly),
  "cal.com": mark(siCaldotcom),
  "clickup.com": mark(siClickup),
  "todoist.com": mark(siTodoist),
  "basecamp.com": mark(siBasecamp),
  "coda.io": mark(siCoda),
  "miro.com": mark(siMiro),
  "loom.com": mark(siLoom),
  "box.com": mark(siBox),
  "typeform.com": mark(siTypeform),
  "webflow.com": mark(siWebflow),
  "zoho.com": mark(siZoho),
  // Commerce and money.
  "shopify.com": mark(siShopify),
  "myshopify.com": mark(siShopify),
  "paypal.com": mark(siPaypal),
  "squareup.com": mark(siSquare),
  "wise.com": mark(siWise),
  "xero.com": mark(siXero),
  "quickbooks.intuit.com": mark(siQuickbooks),
  "gusto.com": mark(siGusto),
  // Mail and marketing.
  "mailchimp.com": mark(siMailchimp),
  "brevo.com": mark(siBrevo),
  "resend.com": mark(siResend),
  // Messaging and social.
  "discord.com": mark(siDiscord),
  "telegram.org": mark(siTelegram),
  "whatsapp.com": mark(siWhatsapp),
  "x.com": mark(siX),
  "twitter.com": mark(siX),
  "facebook.com": mark(siFacebook),
  "instagram.com": mark(siInstagram),
  "reddit.com": mark(siReddit),
  // Research and models.
  "anthropic.com": mark(siAnthropic),
  "perplexity.ai": mark(siPerplexity),
  "elevenlabs.io": mark(siElevenlabs),
  "huggingface.co": mark(siHuggingface),
  "brave.com": mark(siBrave),
};

/** The domains with a bundled mark, for tests and for anyone listing them. */
export const BRAND_MARK_DOMAINS: readonly string[] = Object.freeze(Object.keys(MARKS));

/**
 * The bundled mark for a normalized domain, or null. A subdomain that is not
 * listed itself falls back to its registrable domain (`api.slack.com` draws
 * Slack's mark; `drive.google.com` is listed and draws Google Drive's).
 */
export function brandMarkFor(domain: string | null | undefined): BrandMark | null {
  const host = (domain ?? "").trim().toLowerCase();
  if (!host) return null;
  const exact = MARKS[host];
  if (exact) return exact;
  const labels = host.split(".");
  if (labels.length > 2) {
    const registrable = labels.slice(-2).join(".");
    return MARKS[registrable] ?? null;
  }
  return null;
}

/**
 * Which tile a mark sits on: a light tile for a dark mark, a dark tile for a
 * light one. Decided from the brand colour's relative luminance (sRGB, WCAG),
 * so Intercom's pale cyan is not lost on white and Notion's black is not lost
 * on dark glass.
 */
export function markTile(hex: string): "light" | "dark" {
  return relativeLuminance(hex) > 0.5 ? "dark" : "light";
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return 0;
  const channel = (at: number): number => {
    const c = parseInt(clean.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
