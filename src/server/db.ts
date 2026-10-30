/**
 * Minimal Postgres access layer.
 *
 * Production: `postgres` (porsager) against managed Postgres via DATABASE_URL.
 * Local dev / tests: embedded PGlite (real Postgres compiled to WASM), so the
 * same SQL, constraints and row locks are exercised without a server.
 *
 * The rest of the code only sees `Db` / `Tx` with parameterised `query()`.
 */
import "server-only";
import { config, isHostedDeployment } from "./env";
import { MIGRATIONS } from "./migrations";

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends object = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Run `fn` in a transaction. Rolls back if `fn` throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- postgres.js

async function createPostgresDb(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    // Serverless: one connection per instance, no prepared statements so it
    // also works through transaction-mode poolers (Supabase/Neon pgbouncer).
    max: Number(process.env.DATABASE_POOL_MAX ?? 3),
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });

  const wrap = (s: typeof sql): Queryable => ({
    async query<T extends object>(text: string, params: unknown[] = []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await s.unsafe(text, params as any[]);
      return rows as unknown as T[];
    },
  });

  return {
    ...wrap(sql),
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await sql.begin(async (t: any) => fn(wrap(t)))) as T;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

// --------------------------------------------------------------------- PGlite

async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;

  // PGlite is single-connection; serialise transactions so concurrent API
  // calls in `next dev` behave like separate Postgres sessions would.
  let chain: Promise<unknown> = Promise.resolve();

  const q: Queryable = {
    async query<T extends object>(text: string, params: unknown[] = []) {
      const res = await pg.query<T>(text, params);
      return res.rows;
    },
  };

  return {
    ...q,
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const run = async () =>
        pg.transaction(async (t) => {
          const tq: Queryable = {
            async query<R extends object>(text: string, params: unknown[] = []) {
              const res = await t.query<R>(text, params);
              return res.rows;
            },
          };
          return fn(tq);
        });
      const next = chain.then(run, run);
      chain = next.catch(() => undefined);
      return next as Promise<T>;
    },
    async close() {
      await pg.close();
    },
  };
}

// ------------------------------------------------------------------ singleton

declare global {
  var __interpDb: Promise<Db> | undefined;
}

export async function migrate(db: Db): Promise<void> {
  await db.query(
    "create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())",
  );
  for (const m of MIGRATIONS) {
    await db.tx(async (t) => {
      // Serialise concurrent cold starts.
      await t.query("select pg_advisory_xact_lock(8814201)");
      const done = await t.query("select 1 from schema_migrations where id = $1", [m.id]);
      if (done.length > 0) return;
      for (const statement of splitSql(m.sql)) {
        await t.query(statement);
      }
      await t.query("insert into schema_migrations (id) values ($1)", [m.id]);
    });
  }
}

/** Split a migration into statements (no semicolons inside our literals). */
export function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter((s) => s.length > 0);
}

async function createDb(): Promise<Db> {
  const url = config.databaseUrl;
  let db: Db;
  if (url) {
    db = await createPostgresDb(url);
  } else {
    if (isHostedDeployment() && process.env.ALLOW_EMBEDDED_DB !== "1") {
      throw new Error(
        "DATABASE_URL is not configured. Hosted deployments need managed Postgres; " +
          "the embedded dev database is not shared between serverless instances.",
      );
    }
    const dir = process.env.PGLITE_DIR ?? (process.env.VITEST ? undefined : "./.data/pglite");
    db = await createPgliteDb(dir);
  }
  await migrate(db);
  return db;
}

export function getDb(): Promise<Db> {
  if (!globalThis.__interpDb) {
    globalThis.__interpDb = createDb().catch((err) => {
      globalThis.__interpDb = undefined;
      throw err;
    });
  }
  return globalThis.__interpDb;
}

let testDb: Db | undefined;

/** Tests only: an in-memory database with every table emptied. */
export async function resetDbForTests(): Promise<Db> {
  if (!testDb) {
    testDb = await createPgliteDb();
    await migrate(testDb);
  } else {
    await testDb.query(
      `truncate table app_settings, gatherings, participants, groups, group_members, invitations,
         usage_records, audit_events, rate_limits restart identity cascade`,
    );
  }
  globalThis.__interpDb = Promise.resolve(testDb);
  return testDb;
}
