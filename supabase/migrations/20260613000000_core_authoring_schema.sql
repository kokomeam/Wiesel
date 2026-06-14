-- CourseGen Pro — core authoring schema (Phase 1)
-- profiles bridge to auth.users · courses → modules → lessons → blocks(jsonb)
-- RLS-on everywhere, secure by default. Learner/marketplace tables deferred to Phase 2.

create extension if not exists moddatetime schema extensions;

-- ───────────────────────────── profiles ─────────────────────────────
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  plan         text not null default 'hobbyist' check (plan in ('hobbyist','pro','expert')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute procedure extensions.moddatetime(updated_at);

-- auto-create a profile row whenever someone signs up
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ───────────────────────────── courses ──────────────────────────────
create table public.courses (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  description text,
  audience    text,
  level       text check (level in ('beginner','intermediate','advanced')),
  status      text not null default 'draft'   check (status in ('draft','published','archived')),
  visibility  text not null default 'private' check (visibility in ('private','unlisted','public')),
  price_cents integer not null default 0 check (price_cents >= 0),
  tags        text[] not null default '{}',
  theme       jsonb  not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index courses_author_id_idx on public.courses(author_id);
create index courses_status_visibility_idx on public.courses(status, visibility);
create trigger courses_set_updated_at before update on public.courses
  for each row execute procedure extensions.moddatetime(updated_at);

-- ───────────────────────────── modules ──────────────────────────────
create table public.modules (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses(id) on delete cascade,
  title       text not null,
  description text,
  "order"     integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index modules_course_id_idx on public.modules(course_id);
create trigger modules_set_updated_at before update on public.modules
  for each row execute procedure extensions.moddatetime(updated_at);

-- ───────────────────────────── lessons ──────────────────────────────
-- course_id denormalized (alongside module_id) for O(1) RLS checks.
create table public.lessons (
  id                uuid primary key default gen_random_uuid(),
  module_id         uuid not null references public.modules(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  title             text not null,
  objective         text,
  "order"           integer not null default 0,
  estimated_minutes integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index lessons_module_id_idx on public.lessons(module_id);
create index lessons_course_id_idx on public.lessons(course_id);
create trigger lessons_set_updated_at before update on public.lessons
  for each row execute procedure extensions.moddatetime(updated_at);

-- ───────────────────────────── blocks ───────────────────────────────
-- Each block's type-specific payload (slides[], questions[], paragraphs[]…) lives in content jsonb.
create table public.blocks (
  id         uuid primary key default gen_random_uuid(),
  lesson_id  uuid not null references public.lessons(id) on delete cascade,
  course_id  uuid not null references public.courses(id) on delete cascade,
  type       text not null check (type in ('slide_deck','lecture_text','quiz','homework','exercise','example','resource')),
  title      text,
  "order"    integer not null default 0,
  content    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index blocks_lesson_id_idx on public.blocks(lesson_id);
create index blocks_course_id_idx on public.blocks(course_id);
create trigger blocks_set_updated_at before update on public.blocks
  for each row execute procedure extensions.moddatetime(updated_at);

-- ──────────────────────── RLS helper functions ──────────────────────
-- SECURITY DEFINER so they read courses without recursing through RLS.
create function public.is_course_author(cid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.courses
    where id = cid and author_id = (select auth.uid())
  );
$$;

create function public.can_read_course(cid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.courses
    where id = cid
      and (author_id = (select auth.uid())
           or (status = 'published' and visibility = 'public'))
  );
$$;

-- ─────────────────────────────── RLS ────────────────────────────────
alter table public.profiles enable row level security;
alter table public.courses  enable row level security;
alter table public.modules  enable row level security;
alter table public.lessons  enable row level security;
alter table public.blocks   enable row level security;

-- profiles: world-readable (creator names on listings), self-writable
create policy "profiles_select_all"  on public.profiles for select using (true);
create policy "profiles_insert_self" on public.profiles for insert with check ((select auth.uid()) = id);
create policy "profiles_update_self" on public.profiles for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- courses: read own or published+public; author full write
create policy "courses_select" on public.courses for select
  using (author_id = (select auth.uid()) or (status = 'published' and visibility = 'public'));
create policy "courses_insert" on public.courses for insert with check (author_id = (select auth.uid()));
create policy "courses_update" on public.courses for update using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "courses_delete" on public.courses for delete using (author_id = (select auth.uid()));

-- modules: read via can_read_course, write via is_course_author
create policy "modules_select" on public.modules for select using (public.can_read_course(course_id));
create policy "modules_write"  on public.modules for all
  using (public.is_course_author(course_id)) with check (public.is_course_author(course_id));

-- lessons
create policy "lessons_select" on public.lessons for select using (public.can_read_course(course_id));
create policy "lessons_write"  on public.lessons for all
  using (public.is_course_author(course_id)) with check (public.is_course_author(course_id));

-- blocks
create policy "blocks_select" on public.blocks for select using (public.can_read_course(course_id));
create policy "blocks_write"  on public.blocks for all
  using (public.is_course_author(course_id)) with check (public.is_course_author(course_id));

-- ──────────────────────── storage: course-assets ────────────────────
insert into storage.buckets (id, name, public)
values ('course-assets', 'course-assets', true)
on conflict (id) do nothing;

-- public read; writes restricted to each user's own {auth.uid()}/… folder
create policy "course_assets_public_read" on storage.objects for select
  using (bucket_id = 'course-assets');
create policy "course_assets_owner_insert" on storage.objects for insert
  with check (bucket_id = 'course-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "course_assets_owner_update" on storage.objects for update
  using (bucket_id = 'course-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "course_assets_owner_delete" on storage.objects for delete
  using (bucket_id = 'course-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
