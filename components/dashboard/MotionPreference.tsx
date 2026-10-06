"use client";

// The self-host "Animations" switch (owner, 2026-10-06). It writes the cookie
// the dashboard shell reads, and flips the attribute on the live page at once
// so the change needs no reload. See lib/motion.ts.
import { useState } from "react";
import { motionCookieValue } from "@/lib/motion";

export function MotionPreference({ initialOff }: { initialOff: boolean }) {
  const [off, setOff] = useState(initialOff);

  function toggle() {
    const next = !off;
    document.cookie = motionCookieValue(next);
    const root = document.querySelector(".pc-app");
    if (next) root?.setAttribute("data-motion", "off");
    else root?.removeAttribute("data-motion");
    setOff(next);
  }

  return (
    <div className="pc-motion-preference" data-motion-preference={off ? "off" : "on"}>
      <div>
        <p className="pc-motion-preference__state">{off ? "Animations are off" : "Animations are on"}</p>
        <p className="pc-motion-preference__note">
          Covers the dashboard. Saved in this browser only. Your system&rsquo;s &ldquo;reduce
          motion&rdquo; setting turns them off as well, whatever this says.
        </p>
      </div>
      <button type="button" className="ghost" aria-pressed={off} onClick={toggle}>
        {off ? "Turn animations on" : "Turn animations off"}
      </button>
    </div>
  );
}
