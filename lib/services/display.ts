// How each catalog service is presented: its section on the agent page, the
// sentence under that section's title, the Settings hint, and the env var a
// worker reads its governed base URL from.
//
// Presentation only, kept out of lib/services/catalog.ts on purpose: the
// catalog is gateway code reviewed as the SSRF control, and copy is not. Typed
// as a Record over ServiceId so a new catalog entry does not compile until it
// has one of these, and every surface that lists services (agent page,
// Settings, Setup, the reveal) picks it up from here instead of naming each.
import { SERVICE_CATALOG, SERVICE_IDS, type ServiceId } from "@/lib/services/catalog";

export interface ServiceDisplay {
  /** The agent page's section anchor. GitHub keeps its original `agent-services`. */
  sectionId: string;
  /** One sentence under "<Label> access" on the agent page. */
  accessDescription: string;
  /** Shown under the token form in Settings → Services, when it needs saying. */
  settingsHint?: string;
  /** The variable a worker reads this service's governed base URL from. */
  envVar: string;
  /**
   * The service bills the workspace per call on its own side (Brave Search).
   * PassControl does not see that price, so the cap's wording must not call
   * the call free.
   */
  billedPerCall?: boolean;
}

export const SERVICE_DISPLAY: Readonly<Record<ServiceId, ServiceDisplay>> = {
  github: {
    sectionId: "agent-services",
    accessDescription:
      "What this agent may do on GitHub with the workspace's GitHub token, which it never holds. Nothing until you allow it, checked on every call: a choice you untick stops the next one.",
    envVar: "GITHUB_API_URL",
  },
  telegram: {
    sectionId: "agent-services-telegram",
    accessDescription:
      "What this agent may do with the workspace's Telegram bot, whose token it never holds. Nothing until you allow it, checked on every call.",
    settingsHint: "Use the token BotFather gave you for a bot made for your agents, not one people already rely on.",
    envVar: "TELEGRAM_API_URL",
  },
  brave: {
    sectionId: "agent-services-brave",
    accessDescription:
      "What this agent may search with the workspace's Brave Search key, which it never holds. Nothing until you allow it. Brave bills every search, so this agent is held to 30 searches an hour unless you set its own limit below.",
    settingsHint:
      "Brave bills every search to the card on your Brave account, with no limit on Brave's side. PassControl holds each agent to its hourly cap (30 unless you set one).",
    envVar: "BRAVE_SEARCH_API_URL",
    billedPerCall: true,
  },
  notion: {
    sectionId: "agent-services-notion",
    accessDescription:
      "What this agent may do in Notion with the workspace's integration token, which it never holds. It reaches only the pages and databases shared with that integration in Notion. Nothing until you allow it, checked on every call.",
    settingsHint:
      "Create an internal integration at notion.so/profile/integrations and share only the pages your agents need with it: the token reaches exactly what is shared.",
    envVar: "NOTION_API_URL",
  },
  discord: {
    sectionId: "agent-services-discord",
    accessDescription:
      "What this agent may do on Discord as the workspace's bot, whose token it never holds. It reaches only the servers the bot was added to. Nothing until you allow it, checked on every call.",
    settingsHint:
      "Create an application in the Discord Developer Portal, add a bot, and invite it only to the servers your agents need. Use a bot made for your agents.",
    envVar: "DISCORD_API_URL",
  },
};

/** Catalog order, for every surface that lists services. */
export const DISPLAYED_SERVICES: readonly ServiceId[] = SERVICE_IDS;

/** "GitHub, Telegram or Brave Search": every catalog service, for copy that names them. */
export function serviceNames(conjunction: "or" | "and" = "or"): string {
  const labels = DISPLAYED_SERVICES.map((service) => SERVICE_CATALOG[service].label);
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} ${conjunction} ${labels.at(-1)}`;
}
