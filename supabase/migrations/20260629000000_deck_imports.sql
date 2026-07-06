-- CourseGen Pro — Imported Decks (PPT/PPTX/PDF) feature.
--
-- Educators can attach an existing presentation to a lesson as a "slide deck"
-- without converting it into native, editable SlideElement slides. The original
-- file is uploaded to a PRIVATE storage bucket, a worker normalizes it to PDF and
-- renders each page to a preview image, and the in-app rail viewer displays those
-- pages via short-lived SIGNED URLs (never a permanent public URL).
--
-- Design notes:
--   • `imported_deck` is a NEW block type (a sibling of `slide_deck`), so the
--     existing native slide editor is untouched. The block's content jsonb carries
--     a denormalized snapshot; `deck_imports` is the source of truth for status.
--   • `deck_imports.lesson_id` / `block_id` are FK-FREE plain uuids on purpose:
--     the row is created at upload time, BEFORE the client inserts the block, and
--     the course autosave reconcile churns block rows — a hard FK would race it.
--   • Schema is future-ready for Google Slides / OneDrive (source_type +
--     source_external_id) without implementing those providers here.

-- ─────────────── 1. allow `imported_deck` in blocks.type CHECK ───────────────
-- The inline CHECK from 0001 is auto-named; find + drop it robustly, then re-add.
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'public.blocks'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%slide_deck%';
  if cname is not null then
    execute format('alter table public.blocks drop constraint %I', cname);
  end if;
end $$;

alter table public.blocks add constraint blocks_type_check
  check (type in ('slide_deck','imported_deck','lecture_text','quiz','homework','exercise','example','resource'));

-- ───────────────────────────── 2. deck_imports ──────────────────────────────
create table public.deck_imports (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,
  course_id          uuid not null references public.courses(id) on delete cascade,
  lesson_id          uuid,                 -- soft ref (no FK; see header)
  block_id           uuid,                 -- soft ref (no FK; see header)
  source_type        text not null default 'upload'
                       check (source_type in ('upload','google_drive','onedrive')),
  source_external_id text,                 -- future: Google Drive / OneDrive file id
  source_url         text,
  title              text not null,
  original_file_name text not null,
  original_mime_type text not null,
  original_file_size bigint not null,
  original_file_path text not null,        -- storage path of the uploaded original
  preview_pdf_path   text,                 -- normalized PDF (skipped when the upload IS a pdf)
  page_count         integer,
  status             text not null default 'uploaded'
                       check (status in ('uploaded','processing','ready','failed')),
  error              text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index deck_imports_course_id_idx on public.deck_imports(course_id);
create index deck_imports_owner_id_idx  on public.deck_imports(owner_id);
create index deck_imports_status_idx    on public.deck_imports(status);
create trigger deck_imports_set_updated_at before update on public.deck_imports
  for each row execute procedure extensions.moddatetime(updated_at);

-- ───────────────────────────── 3. deck_import_pages ─────────────────────────
-- Normalized per-page rows. Page assets live in storage; rows hold paths + dims.
create table public.deck_import_pages (
  id             uuid primary key default gen_random_uuid(),
  deck_import_id uuid not null references public.deck_imports(id) on delete cascade,
  page_number    integer not null,
  image_path     text not null,
  thumbnail_path text,
  width          integer,
  height         integer,
  created_at     timestamptz not null default now(),
  unique (deck_import_id, page_number)
);
create index deck_import_pages_deck_import_id_idx on public.deck_import_pages(deck_import_id);

-- ──────────────────────── 4. RLS helper (pages → author) ────────────────────
-- Lives in `private` (like is_course_author) so it isn't callable via /rest/v1/rpc.
-- SECURITY DEFINER + owned by the migration role ⇒ reads the parent tables past RLS.
create function private.is_deck_import_author(did uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
    from public.deck_imports di
    join public.courses c on c.id = di.course_id
    where di.id = did and c.author_id = (select auth.uid())
  );
$$;

-- ─────────────────────────────────── 5. RLS ─────────────────────────────────
alter table public.deck_imports      enable row level security;
alter table public.deck_import_pages enable row level security;

-- deck_imports: author-only (no public read — imported decks are private assets).
create policy "deck_imports_select" on public.deck_imports for select
  using (private.is_course_author(course_id));
create policy "deck_imports_insert" on public.deck_imports for insert
  with check (private.is_course_author(course_id) and owner_id = (select auth.uid()));
create policy "deck_imports_update" on public.deck_imports for update
  using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "deck_imports_delete" on public.deck_imports for delete
  using (private.is_course_author(course_id));

-- deck_import_pages: gated through the parent deck import's author.
create policy "deck_import_pages_select" on public.deck_import_pages for select
  using (private.is_deck_import_author(deck_import_id));
create policy "deck_import_pages_insert" on public.deck_import_pages for insert
  with check (private.is_deck_import_author(deck_import_id));
create policy "deck_import_pages_update" on public.deck_import_pages for update
  using (private.is_deck_import_author(deck_import_id)) with check (private.is_deck_import_author(deck_import_id));
create policy "deck_import_pages_delete" on public.deck_import_pages for delete
  using (private.is_deck_import_author(deck_import_id));

-- ─────────────────── 6. storage: PRIVATE deck-imports bucket ─────────────────
-- Distinct from the public `course-assets` bucket: originals + rendered pages must
-- only ever be reachable via server-issued signed URLs. First path segment is the
-- owner's uid (matches the folder-ownership RLS), e.g.
--   {ownerId}/{courseId}/{deckImportId}/original/{safeName}
--   {ownerId}/{courseId}/{deckImportId}/preview/deck.pdf
--   {ownerId}/{courseId}/{deckImportId}/pages/page-001.png
--   {ownerId}/{courseId}/{deckImportId}/thumbs/page-001.png
insert into storage.buckets (id, name, public)
values ('deck-imports', 'deck-imports', false)
on conflict (id) do nothing;

create policy "deck_imports_obj_select" on storage.objects for select
  using (bucket_id = 'deck-imports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "deck_imports_obj_insert" on storage.objects for insert
  with check (bucket_id = 'deck-imports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "deck_imports_obj_update" on storage.objects for update
  using (bucket_id = 'deck-imports' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "deck_imports_obj_delete" on storage.objects for delete
  using (bucket_id = 'deck-imports' and (storage.foldername(name))[1] = (select auth.uid())::text);
