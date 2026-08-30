import { DashboardBrand } from "@/components/dashboard/DashboardBrand";

export function DashboardSkeleton({ variant = "overview" }: { variant?: "overview" | "settings" | "agent" }) {
  return (
    <div className="pc-app min-h-screen bg-background text-foreground" data-state="loading" aria-busy="true" aria-label="Loading dashboard">
      <div className="pc-shell-grid">
        <aside className="pc-sidebar">
          <div className="pc-sidebar__brand"><DashboardBrand markSize={27} wordmarkSize={17} /></div>
          <div className="pc-skeleton pc-skeleton--line" />
          <div className="pc-skeleton pc-skeleton--nav" />
          <div className="pc-skeleton pc-skeleton--nav" />
          <div className="pc-skeleton pc-skeleton--nav" />
        </aside>
        <div className="pc-workspace">
          <header className="pc-page-header">
            <div><div className="pc-skeleton pc-skeleton--kicker" /><div className="pc-skeleton pc-skeleton--title" /></div>
            <div className="pc-skeleton pc-skeleton--control" />
          </header>
          <main className="pc-content">
            <div className="pc-skeleton pc-skeleton--alert" />
            {variant === "overview" ? <section className="pc-skeleton-panel pc-skeleton--operations" data-skeleton="operations"><div className="pc-skeleton pc-skeleton--kicker" /><div className="pc-skeleton pc-skeleton--heading" /><div className="pc-skeleton pc-skeleton--operations-grid" /></section> : null}
            {variant === "overview" ? <div className="pc-skeleton-grid">{Array.from({ length: 4 }, (_, index) => <div className="pc-skeleton pc-skeleton--metric" key={index} />)}</div> : null}
            {/* The profile section is first on the settings page, so its
                placeholder is first here — a skeleton whose blocks land in a
                different order than the page is a layout shift, not a hint. */}
            {variant === "settings" ? <section className="pc-skeleton-panel" data-skeleton="profile"><div className="pc-skeleton pc-skeleton--kicker" /><div className="pc-skeleton pc-skeleton--heading" /><div className="pc-skeleton pc-skeleton--table short" /></section> : null}
            <section className="pc-skeleton-panel"><div className="pc-skeleton pc-skeleton--kicker" /><div className="pc-skeleton pc-skeleton--heading" /><div className="pc-skeleton pc-skeleton--table" /></section>
            <section className="pc-skeleton-panel"><div className="pc-skeleton pc-skeleton--kicker" /><div className="pc-skeleton pc-skeleton--heading" /><div className="pc-skeleton pc-skeleton--table short" /></section>
          </main>
        </div>
      </div>
    </div>
  );
}
