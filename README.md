# Mad Storyteller — Lovecraftian MVP

A Netlify-ready React + Vite storytelling app built for the **Chaos Challenge**.

## What this MVP includes

- Primary genre bound to **Lovecraftian Madness**.
- Sidebar with Supabase-persisted tales scoped to a session cookie.
- Main chat space for narrative interaction.
- Storyteller backend via Netlify Function + OpenAI Chat Completions.
- ElevenLabs narration button on each AI response (`Read aloud` / `Stop voice`).
- Portrait generation button on each AI response that runs as a background job and attaches the generated image to that message.
- Latent doom client streaming (token-by-token reveal) with extra dramatic pause on:
  - `...`
  - `.` followed by newline
- Agent/system definition in [AGENTS.md](AGENTS.md).

## Run locally

1. Install dependencies:

```bash
npm install
```

1. Add environment variables (see `.env.example`):

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional, defaults to `gpt-4.1-mini`)
- `OPENAI_IMAGE_MODEL` (optional, defaults to `gpt-image-1`)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (recommended for server-side persistence)
- `SUPABASE_ANON_KEY` (optional fallback if service role key is not provided)
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ELEVENLABS_MODEL_ID` (optional, defaults to `eleven_turbo_v2_5`)

1. Create the Supabase table used by `/api/tales`:

```sql
-- from supabase/schema.sql
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
```

1. Run app (frontend only):

```bash
npm run dev
```

1. Run full Netlify app (frontend + `/api/chat`, `/api/tales`, `/api/tts`, `/api/portrait-job`, `/api/portrait-background` functions):

```bash
npm run dev:netlify
```

## Netlify deployment

This repo includes [netlify.toml](netlify.toml) with:

- `build.command = npm run build`
- `build.publish = dist`
- `build.functions = netlify/functions`
- redirect from `/api/*` to `/.netlify/functions/:splat`

Set `OPENAI_API_KEY` in Netlify environment variables before deploying.
Also set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_VOICE_ID`.

## Future expansions

- Image generation pipeline for scene cards and chapter covers.
