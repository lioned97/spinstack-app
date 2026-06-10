-- SpinStack v2 — run once in Supabase: SQL Editor → New query → paste → Run.
-- One shared row, no login. Policies are scoped to your row's UUID.

create table if not exists public.shared_state (
  id uuid primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

alter table public.shared_state enable row level security;

drop policy if exists "spinstack shared read"   on public.shared_state;
drop policy if exists "spinstack shared insert" on public.shared_state;
drop policy if exists "spinstack shared update" on public.shared_state;

create policy "spinstack shared read" on public.shared_state
  for select to anon using (id = '1d8bb4fc-0d6e-499b-82b3-afc5be7e9337'::uuid);

create policy "spinstack shared insert" on public.shared_state
  for insert to anon with check (id = '1d8bb4fc-0d6e-499b-82b3-afc5be7e9337'::uuid);

create policy "spinstack shared update" on public.shared_state
  for update to anon using (id = '1d8bb4fc-0d6e-499b-82b3-afc5be7e9337'::uuid);
