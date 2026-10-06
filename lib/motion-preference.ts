// Server half of lib/motion.ts: reads the switch for the dashboard shell.
// Only ever called from DashboardShell (and Settings), which are dynamic
// already; calling cookies() in the root layout would make every prerendered
// page dynamic.
import { cookies } from "next/headers";
import { MOTION_COOKIE } from "@/lib/motion";

export async function motionTurnedOff(): Promise<boolean> {
  return (await cookies()).get(MOTION_COOKIE)?.value === "off";
}
