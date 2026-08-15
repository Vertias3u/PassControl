import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";

export function DashboardSkeleton({ variant = "overview" }: { variant?: "overview" | "settings" | "agent" }) {
  return (
    <div className="pc-app min-h-screen bg-background text-foreground" data-state="loading" aria-busy="true" aria-label="Loading dashboard">
      <div className="pc-shell-grid">
        <aside className="pc-sidebar">
          <div className="pc-sidebar__brand"><VertiasLogo size={27} /><span><VertiasWordmark size={17} /><small>PassControl</small></span></div>
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
            <section className="pc-skeleton-panel"><div className="pc-skeleton pc-skeleton--kicker" /><div className="pc-skeleton pc-skeleton--heading" /><div className="pc-skeleton pc-skeleton--table" /></section>
            <section className="pc-skeleton-panel"><div className="pc-skeleton pc-skeleton--kicker" /><div className="pc-skeleton pc-skeleton--heading" /><div className="pc-skeleton pc-skeleton--table short" /></section>
          </main>
        </div>
      </div>
    </div>
  );
}
