import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSIONS } from "@/server/db/extensions";

// Le regole delle migrazioni (RLS, grant e chiavi) controllate sul testo di ogni
// migrazione: un errore qui esce prima di arrivare a Supabase.

const MIGRATIONS_DIR = resolve("supabase/migrations");
const FILE_NAME = /^\d{14}_[a-z0-9_]+\.sql$/;
const NOW_COLUMNS = new Set(["created_at", "updated_at"]);

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
}

/** Il testo da `start` alla fine della clausola: virgola o `;` fuori dalle parentesi, o la `)` che la chiude. */
function clauseFrom(sql: string, start: number): string {
  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    const c = sql[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return sql.slice(start, i);
      depth--;
    } else if ((c === "," && depth === 0) || c === ";") return sql.slice(start, i);
  }
  return sql.slice(start);
}

/** La colonna a cui appartiene il `default` che inizia in `at`. */
function columnBefore(sql: string, at: number): string {
  let depth = 0;
  let i = at - 1;
  for (; i >= 0; i--) {
    const c = sql[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) break;
      depth--;
    } else if ((c === "," && depth === 0) || c === ";") break;
  }
  // Il primo comando di un `alter table` porta con sé `alter table <nome>`: lo si toglie, così
  // restano `add [column] x ...` o `alter [column] x ...`, dove `column` è facoltativo.
  const segment = sql
    .slice(i + 1, at)
    .trim()
    .replace(/^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?[a-z0-9_."]+\s+/i, "");
  const named =
    /^(?:alter|add)\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/i.exec(segment) ??
    /^"?([a-z0-9_]+)"?/i.exec(segment);
  return named?.[1]?.toLowerCase() ?? segment;
}

// Ogni lettura dell'orologio: now(), le sue forme SQL e le funzioni *_timestamp(). Si cerca
// dentro l'espressione di ogni `default`, non solo all'inizio: `default (now() at time zone ...)::date`
// e `default timezone('Europe/Rome', now())` leggono l'orologio come `default now()`.
const CLOCK_TOKEN =
  /\b(now\s*\(\s*\)|(?:current_timestamp|localtimestamp|current_time|localtime)\b(?:\s*\(\s*\d*\s*\))?|current_date\b|(?:clock|statement|transaction)_timestamp\s*\(\s*\))/i;

// Come in eslint.config.mjs (ROLE_SQL): in PGlite la sessione è `postgres`, quindi un cambio di
// ruolo dentro una funzione fa uscire dalla RLS tutta la transazione che la chiama. Lo stesso vale per
// `session authorization` (torna al superutente della sessione) e per i claim JWT (cambiano l'utente che
// `auth.uid()` legge). Il `(?!\s*=)` lascia passare `update ... set role = ...`, l'update della colonna
// `physicians.role`; leggere i claim con `current_setting` non è un cambio.
const ROLE_SWITCH = [
  /set_config\s*\(\s*'(role|session_authorization|request\.jwt\.claims?(\.[a-z_]+)?)'/i,
  /\b(re)?set\s+(local\s+|session\s+)?role\b(?!\s*=)/i,
  /\b(re)?set\s+(local\s+|session\s+)?session\s+authorization\b/i,
  /\b(re)?set\s+(local\s+|session\s+)?(session_authorization|request\.jwt\.claims?(\.[a-z_]+)?)\b/i,
];

/** Le regole violate da una migrazione: `[]` se è a posto. */
function lintMigration(fileName: string, text: string): string[] {
  const sql = stripComments(text.replace(/\r\n/g, "\n"));
  const violations: string[] = [];

  if (!FILE_NAME.test(fileName)) violations.push("nome del file fuori formato");
  if (/\bcreate\s+role\b/i.test(sql)) violations.push("create role");
  if (/\blocal_meta\b/i.test(sql)) violations.push("local_meta");
  if (/\bcreate\s+(?:or\s+replace\s+)?(?:table|function|schema)\s+(?:if\s+not\s+exists\s+)?"?auth"?\b/i.test(sql)) {
    violations.push("oggetto nello schema auth");
  }

  for (const [, table] of sql.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)) {
    const rls = new RegExp(
      `\\balter\\s+table\\s+(?:only\\s+)?public\\.${table}\\s+enable\\s+row\\s+level\\s+security\\b`,
      "i",
    );
    if (!rls.test(sql)) violations.push(`public.${table} senza enable row level security`);
  }

  // Le opzioni della funzione stanno fra `security definer` e il corpo ($$ o $tag$).
  for (const [, options] of sql.matchAll(/\bsecurity\s+definer\b([\s\S]*?)(?:\$[a-z_]*\$|;)/gi)) {
    if (!/\bset\s+search_path\s*(?:=|to)\s*''/i.test(options ?? "")) {
      violations.push("security definer senza set search_path = ''");
    }
  }

  for (const [, name = "", rest = ""] of sql.matchAll(
    /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?([^;]*)/gi,
  )) {
    if (!Object.hasOwn(EXTENSIONS, name)) violations.push(`estensione ${name} non è in EXTENSIONS`);
    if (!/\bwith\s+schema\s+extensions\b/i.test(rest)) violations.push(`estensione ${name} senza with schema extensions`);
  }

  for (const match of sql.matchAll(/\bforeign\s+key\s*\(\s*"?practice_id"?\s*,/gi)) {
    if (/\bon\s+delete\s+set\s+null\b/i.test(clauseFrom(sql, match.index))) {
      violations.push("on delete set null su una foreign key (practice_id, ...)");
    }
  }

  for (const match of sql.matchAll(/\bdefault\b/gi)) {
    const token = CLOCK_TOKEN.exec(clauseFrom(sql, match.index + match[0].length))?.[1];
    if (token === undefined) continue;
    const column = columnBefore(sql, match.index);
    if (!NOW_COLUMNS.has(column)) {
      violations.push(`default ${token.toLowerCase().replace(/\s+/g, "")} sulla colonna ${column}`);
    }
  }

  if (ROLE_SWITCH.some((role) => role.test(sql))) violations.push("cambio di ruolo o di utente");

  return violations;
}

// Una cartella che manca è una cartella vuota: lo dice il primo test, e le regole si provano lo stesso.
const migrations = existsSync(MIGRATIONS_DIR) ? readdirSync(MIGRATIONS_DIR).sort() : [];

describe("migrazioni di supabase/migrations", () => {
  it("ce n'è almeno una", () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it.each(migrations)("%s rispetta le regole", (fileName) => {
    expect(lintMigration(fileName, readFileSync(join(MIGRATIONS_DIR, fileName), "utf8"))).toEqual([]);
  });
});

describe("lintMigration", () => {
  const ok = "20990101000000_ok.sql";

  it("accetta una migrazione che segue le regole", () => {
    const sql = `
      create extension if not exists pg_trgm with schema extensions;
      -- un commento con create role e local_meta non conta
      create table public.t (
        id uuid primary key default gen_random_uuid(),
        practice_id uuid not null references public.practices (id) on delete restrict,
        parent_id uuid not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz(6) not null default now(),
        foreign key (practice_id, parent_id) references public.p (practice_id, id) on delete cascade
      );
      alter table public.t enable row level security;
      create function app.f() returns int language sql stable security definer set search_path = ''
      as $$ select 1 $$;
    `;
    expect(lintMigration(ok, sql)).toEqual([]);
  });

  it.each([
    ["2026_core.sql", "select 1;", "nome del file fuori formato"],
    [ok, "create role editor;", "create role"],
    [ok, "select * from local_meta.schema_migrations;", "local_meta"],
    [ok, "create table auth.sessions (id uuid);", "oggetto nello schema auth"],
    [ok, "create or replace function auth.uid() returns uuid language sql as $$ select null $$;", "oggetto nello schema auth"],
    [ok, "create schema if not exists auth;", "oggetto nello schema auth"],
    [ok, "create table public.t (id int);", "public.t senza enable row level security"],
    [
      ok,
      "create function app.f() returns int language sql security definer as $$ select 1 $$;",
      "security definer senza set search_path = ''",
    ],
    [
      ok,
      "create function app.f() returns int language sql security definer set search_path = public as $$ select 1 $$;",
      "security definer senza set search_path = ''",
    ],
    [ok, "create extension if not exists btree_gist with schema extensions;", "estensione btree_gist non è in EXTENSIONS"],
    [ok, "create extension if not exists pg_trgm;", "estensione pg_trgm senza with schema extensions"],
    [
      ok,
      "alter table public.t add foreign key (practice_id, x_id) references public.x (practice_id, id) on delete set null;",
      "on delete set null su una foreign key (practice_id, ...)",
    ],
    [ok, "alter table public.t add column issued_at timestamptz not null default now();", "default now() sulla colonna issued_at"],
    [ok, "alter table public.t alter column issued_at set default now();", "default now() sulla colonna issued_at"],
    // Ogni lettura dell'orologio, non solo now(), e anche nelle forme senza `column`.
    [ok, "alter table public.t add visit_date date not null default current_date;", "default current_date sulla colonna visit_date"],
    [ok, "alter table public.t add issued_at timestamptz default CURRENT_TIMESTAMP;", "default current_timestamp sulla colonna issued_at"],
    [ok, "alter table public.t add issued_at timestamptz default current_timestamp(3);", "default current_timestamp(3) sulla colonna issued_at"],
    [ok, "alter table public.t add issued_at timestamp default localtimestamp;", "default localtimestamp sulla colonna issued_at"],
    [ok, "alter table public.t add start_time time default current_time;", "default current_time sulla colonna start_time"],
    [ok, "alter table public.t add start_time time default localtime;", "default localtime sulla colonna start_time"],
    [ok, "alter table public.t add issued_at timestamptz default clock_timestamp();", "default clock_timestamp() sulla colonna issued_at"],
    [ok, "alter table public.t add issued_at timestamptz default statement_timestamp();", "default statement_timestamp() sulla colonna issued_at"],
    [ok, "alter table public.t add issued_at timestamptz default transaction_timestamp();", "default transaction_timestamp() sulla colonna issued_at"],
    [ok, "alter table public.t add if not exists issued_at timestamptz default now();", "default now() sulla colonna issued_at"],
    [ok, "alter table public.t alter issued_at set default now();", "default now() sulla colonna issued_at"],
    // L'orologio dentro un'espressione: il default non inizia con now(), ma lo legge lo stesso.
    [
      ok,
      "alter table public.t add visit_date date default (now() at time zone 'Europe/Rome')::date;",
      "default now() sulla colonna visit_date",
    ],
    [
      ok,
      "alter table public.t add issued_on date default timezone('Europe/Rome', now());",
      "default now() sulla colonna issued_on",
    ],
    [ok, "alter table public.t add issued_on date default (current_date + 1);", "default current_date sulla colonna issued_on"],
    // Un cambio di ruolo in una funzione SQL fa uscire dalla RLS tutta la transazione che la chiama.
    [
      ok,
      "create function app.f() returns trigger language plpgsql as $$ begin perform set_config('role', 'postgres', true); return new; end $$;",
      "cambio di ruolo o di utente",
    ],
    [
      ok,
      "create function app.f() returns void language sql as $$ set local role postgres $$;",
      "cambio di ruolo o di utente",
    ],
    // Il cambio di utente: session authorization e i claim JWT, che auth.uid() legge.
    [
      ok,
      "create function app.f() returns void language sql as $$ set local session authorization default $$;",
      "cambio di ruolo o di utente",
    ],
    [
      ok,
      "create function app.f() returns void language sql as $$ reset session authorization $$;",
      "cambio di ruolo o di utente",
    ],
    [
      ok,
      "create function app.f() returns void language sql as $$ select set_config('session_authorization', 'postgres', true) $$;",
      "cambio di ruolo o di utente",
    ],
    [
      ok,
      "create function app.f() returns void language sql as $$ select set_config('request.jwt.claim.sub', 'x', true) $$;",
      "cambio di ruolo o di utente",
    ],
    [
      ok,
      "create function app.f() returns void language sql as $$ select set_config('request.jwt.claims', '{}', true) $$;",
      "cambio di ruolo o di utente",
    ],
    [
      ok,
      "create function app.f() returns void language plpgsql as $$ begin set local request.jwt.claim.sub = 'x'; end $$;",
      "cambio di ruolo o di utente",
    ],
    [
      ok,
      "create function app.f() returns void language plpgsql as $$ begin set local session_authorization = 'postgres'; end $$;",
      "cambio di ruolo o di utente",
    ],
  ])("%s: %s", (fileName, sql, violation) => {
    expect(lintMigration(fileName, sql)).toEqual([violation]);
  });

  it("accetta le letture dell'orologio su created_at e updated_at, anche con alter table", () => {
    const sql = `
      alter table public.t add created_at timestamptz not null default current_timestamp;
      alter table public.t add column if not exists updated_at timestamptz default now(),
        add note text default 'x';
      alter table public.t alter updated_at set default clock_timestamp();
      alter table public.t add created_at timestamptz default (now() at time zone 'utc');
    `;
    expect(lintMigration("20990101000000_t.sql", sql)).toEqual([]);
  });

  it("accetta set role = ... come update della colonna role", () => {
    expect(lintMigration("20990101000000_t.sql", "update public.physicians set role = 'mmg';")).toEqual([]);
  });

  it("accetta di leggere i claim JWT, come fa auth.uid()", () => {
    const sql = "create function app.f() returns text language sql as $$ select current_setting('request.jwt.claims', true) $$;";
    expect(lintMigration("20990101000000_t.sql", sql)).toEqual([]);
  });

  it("un solo cambio di ruolo o di utente per file, anche se ce ne sono due", () => {
    const sql = `
      create function app.f() returns void language sql as $$ set local role postgres $$;
      create function app.g() returns void language sql as $$ select set_config('role', 'postgres', true) $$;
    `;
    expect(lintMigration("20990101000000_t.sql", sql)).toEqual(["cambio di ruolo o di utente"]);
  });

  it("una colonna dopo un'altra nello stesso alter table", () => {
    const sql = "alter table public.t add note text, add visit_date date default current_date;";
    expect(lintMigration("20990101000000_t.sql", sql)).toEqual(["default current_date sulla colonna visit_date"]);
  });

  it("default now() dentro create table", () => {
    const sql = `
      create table public.t (
        id uuid primary key,
        visit_date date not null default now(),
        created_at timestamptz not null default now()
      );
      alter table public.t enable row level security;
    `;
    expect(lintMigration("20990101000000_t.sql", sql)).toEqual(["default now() sulla colonna visit_date"]);
  });

  it("default current_date dentro create table", () => {
    const sql = `
      create table public.t (
        id uuid primary key,
        visit_date date not null default current_date,
        created_at timestamptz not null default current_timestamp
      );
      alter table public.t enable row level security;
    `;
    expect(lintMigration("20990101000000_t.sql", sql)).toEqual(["default current_date sulla colonna visit_date"]);
  });
});
