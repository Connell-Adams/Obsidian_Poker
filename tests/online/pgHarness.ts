import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

/**
 * A real PostgreSQL (compiled to WebAssembly) with the parts of Supabase the
 * migration relies on: the auth schema, auth.uid(), the anon, authenticated and
 * service_role roles, and the realtime publication. Lets the actual migration,
 * policies and functions be tested here.
 */
export async function createTestDatabase(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    create publication supabase_realtime;
  `);
  await db.exec(readFileSync('supabase/migrations/20261107000000_online.sql', 'utf8'));
  // Supabase grants the service role everything; mirror that.
  await db.exec(`
    grant all on all tables in schema public to service_role;
    grant all on all functions in schema public to service_role;
    grant all on all sequences in schema public to service_role;
  `);
  return new TestDb(db);
}

export class TestDb {
  constructor(readonly pg: PGlite) {}

  /** Creates an auth user, firing the signup trigger like Supabase Auth would. */
  async createUser(id: string, meta: Record<string, unknown> = {}): Promise<void> {
    // Supabase Auth inserts users with full privileges, which fires the signup trigger.
    await this.pg.exec('reset role');
    await this.pg.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [id, `${id.slice(0, 8)}@test.dev`, JSON.stringify(meta)]);
  }

  async asService(): Promise<void> {
    await this.pg.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role service_role;`);
  }

  async asUser(id: string): Promise<void> {
    await this.pg.exec(`reset role; select set_config('request.jwt.claim.sub', '${id}', false); set role authenticated;`);
  }

  async asAnon(): Promise<void> {
    await this.pg.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;`);
  }

  async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pg.query<T>(sql, params);
    return result.rows;
  }

  /** Calls a function with named arguments, the way supabase-js `rpc` does. */
  async rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const keys = Object.keys(args);
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const values = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    const result = await this.pg.query<{ result: unknown }>(`select public.${name}(${named}) as result`, values);
    return result.rows[0]?.result;
  }

  /** The error message of a failing call, or null when it succeeds. */
  async errorOf(run: () => Promise<unknown>): Promise<string | null> {
    try {
      await run();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
