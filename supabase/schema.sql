create table if not exists public.tales (
  id text primary key,
  session_id text not null,
  title text not null,
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.tales
  drop column if exists portrait_url;

create index if not exists tales_session_updated_idx
  on public.tales (session_id, updated_at desc);

create table if not exists public.portrait_jobs (
  id uuid primary key,
  session_id text not null,
  message_id text not null,
  tale_title text,
  seed_text text,
  status text not null check (status in ('queued', 'processing', 'completed', 'failed')),
  image_data_url text,
  image_url text,
  error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists portrait_jobs_session_updated_idx
  on public.portrait_jobs (session_id, updated_at desc);
