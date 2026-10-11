/**
 * The *.db.test.ts files each apply a migration inside `begin … rollback` against the
 * same dev database, and vitest runs them in parallel. Their DDL and their writes to
 * `users` / `agents` take locks in different orders, so two of them can deadlock;
 * Postgres then aborts one transaction with "deadlock detected" (4 of 5 runs of the
 * ten files together on 2026-10-11, and the pre-push hook refused the 1.5.0 push over
 * it). The aborted transaction rolled back whole, and every one of these tests rolls
 * back anyway, so running it again is exactly the same test. Only a deadlock is
 * retried: every other error, including the ones a test expects, comes straight back.
 */
const DEADLOCK = /deadlock detected/;

export function retryOnDeadlock(run: () => { ok: boolean; out: string }): { ok: boolean; out: string } {
  for (let attempt = 0; ; attempt++) {
    const result = run();
    if (result.ok || !DEADLOCK.test(result.out) || attempt >= 20) return result;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + Math.floor(Math.random() * 200));
  }
}

/** The same, for a helper that throws on failure (execFileSync's error carries stderr). */
export function retryThrowingOnDeadlock<T>(run: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return run();
    } catch (error) {
      const stderr = String((error as { stderr?: Buffer | string }).stderr ?? "");
      if (!DEADLOCK.test(stderr) || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + Math.floor(Math.random() * 200));
    }
  }
}
