"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function SystemHealthRefresh() {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();

  const refresh = () => {
    startTransition(() => {
      router.replace(`/dashboard/system?refresh=${Date.now()}`, { scroll: false });
    });
  };

  return (
    <button type="button" className="pc-system-health-refresh" onClick={refresh} disabled={refreshing} aria-busy={refreshing}>
      <RefreshCw aria-hidden="true" />
      <span>{refreshing ? "Refreshing snapshot" : "Refresh snapshot"}</span>
    </button>
  );
}
