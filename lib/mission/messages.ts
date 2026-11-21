// What a mission-only agent is told between missions (R11-01, plans/mission-only-design.md).
// Its own module so the many route tests that mock lib/mission/gate need not know it.
export const MISSION_REQUIRED_MESSAGE =
  "This agent works only on missions, and none is in force. Draft one (the agent's POST /api/v1/missions, or the dashboard) and the owner approves it.";
