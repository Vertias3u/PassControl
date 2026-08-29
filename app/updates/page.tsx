import type { Metadata } from "next";
import Link from "next/link";
import { VertiasLogo } from "@/components/VertiasLogo";
import { PASSCONTROL_CONTACT_EMAIL, PASSCONTROL_CONTACT_MAILTO } from "@/lib/contact";
import { RELEASE_NOTES, type ReleaseNote } from "@/lib/release-notes";
import { RELEASE_VERSION } from "@/lib/version";
import styles from "./updates.module.css";

export const runtime = "edge";

export const metadata: Metadata = {
  title: "Updates",
  description:
    "PassControl release notes: what changed for operators and builders, followed by the technical details.",
  alternates: { canonical: "https://passcontrol.vertias.eu/updates" },
  openGraph: {
    title: "PassControl updates",
    description:
      "Plain-language release notes for PassControl, with technical detail when you want it.",
    url: "https://passcontrol.vertias.eu/updates",
  },
};

function releaseId(version: string): string {
  return `v${version.replaceAll(".", "-")}`;
}

function displayDate(date: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function NoteList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;

  return (
    <section className={styles.noteList}>
      <h3>{title}</h3>
      <ul>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </section>
  );
}

function TechnicalNotes({ note, expanded }: { note: ReleaseNote; expanded: boolean }) {
  const hasDetails =
    note.changed?.length || note.fixed?.length || note.security?.length || note.technical?.length;
  if (!hasDetails) return null;

  return (
    <details className={styles.details} open={expanded}>
      <summary>Technical details <span aria-hidden="true">+</span></summary>
      <div className={styles.detailBody}>
        <NoteList title="Changed" items={note.changed} />
        <NoteList title="Fixed" items={note.fixed} />
        <NoteList title="Security" items={note.security} />
        {note.technical?.map((item) => (
          <section className={styles.technicalNote} key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </section>
        ))}
      </div>
    </details>
  );
}

export default function UpdatesPage() {
  return (
    <div className={styles.site}>
      <a className={styles.skip} href="#updates-content">Skip to release notes</a>

      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="PassControl home">
          <VertiasLogo size={25} />
          <strong>ver·tias</strong>
          <span>/ PassControl</span>
        </Link>
        <Link href="/" className={styles.back}>Back to PassControl</Link>
      </header>

      <main className={styles.main} id="updates-content">
        <header className={styles.intro}>
          <p className={styles.eyebrow}>PassControl updates</p>
          <h1>What changed, and why it matters.</h1>
          <p>
            The practical version comes first. Open the technical section when you want
            implementation detail, exact fixes, or security notes.
          </p>
        </header>

        <div className={styles.archive}>
          {RELEASE_NOTES.map((note, index) => {
            const id = releaseId(note.version);
            return (
              <section
                className={styles.release}
                id={id}
                key={note.version}
                data-release-version={note.version}
                aria-labelledby={`${id}-title`}
              >
                <div className={styles.releaseMeta}>
                  <a href={`#${id}`} aria-label={`Link to version ${note.version}`}>
                    v{note.version}
                  </a>
                  {note.version === RELEASE_VERSION ? <span>Latest</span> : null}
                  <time dateTime={note.date}>{displayDate(note.date)}</time>
                </div>

                <div className={styles.releaseBody}>
                  <h2 id={`${id}-title`}>{note.title}</h2>
                  <p className={styles.headline}>{note.headline}</p>

                  <div className={styles.highlights}>
                    {note.highlights.map((highlight) => (
                      <article key={highlight.title}>
                        <h3>{highlight.title}</h3>
                        <p>{highlight.body}</p>
                      </article>
                    ))}
                  </div>

                  <TechnicalNotes note={note} expanded={index === 0} />
                </div>
              </section>
            );
          })}
        </div>
      </main>

      <footer className={styles.footer}>
        <span>© 2026 Kristiyan Ivanov · Vertias project · Sofia, Bulgaria</span>
        <div>
          <Link href="/legal/privacy">Privacy</Link>
          <a href={PASSCONTROL_CONTACT_MAILTO}>{PASSCONTROL_CONTACT_EMAIL}</a>
        </div>
      </footer>
    </div>
  );
}
