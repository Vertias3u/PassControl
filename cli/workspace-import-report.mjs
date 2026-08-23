// Import reporting is shared as a tiny pure module so the CLI's terminal
// branch is tested as behaviour, not merely as a source-text string. In
// particular, a file whose agents were all REFUSED must never print the
// reassuring message reserved for a workspace that already owns every agent.

export function noAgentCreateMessage(agents) {
  const rejected = Array.isArray(agents?.rejected) ? agents.rejected.length : 0;
  const skipped = Array.isArray(agents?.skipped) ? agents.skipped.length : 0;

  if (rejected > 0) {
    return `Nothing was created. ${rejected} agent(s) were refused; review the reasons above before retrying.`;
  }
  if (skipped > 0) {
    return "Nothing to create. The workspace already holds every agent in this file.";
  }
  return "Nothing to create.";
}

export function importCompletionMessage(report) {
  const created = Array.isArray(report?.agents?.created) ? report.agents.created.length : 0;
  return report?.complete === false
    ? `Import completed partially: ${created} agent(s) created; review the refused entries above.`
    : `Created ${created} agent(s).`;
}
