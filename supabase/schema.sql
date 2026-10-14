-- =====================================================================
--  專案管理系統 v4 — Supabase 資料庫結構（個人專案＋分享）
--  使用方式：Supabase 後台 → SQL Editor → New query → 貼上全部 → Run
--  可重複執行（已存在的物件會略過或覆蓋）
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 0. 共用：自動更新 updated_at
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 1. 成員與權限（只有名單內的 Email 才能讀寫資料）
--    role: admin = 管理員（可管理成員）、editor = 編輯者、viewer = 唯讀
-- ---------------------------------------------------------------------
create table if not exists public.app_members (
  email        text primary key check (email = lower(email)),
  role         text not null default 'editor' check (role in ('admin','editor','viewer')),
  display_name text,
  created_at   timestamptz not null default now()
);

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.app_members
  where email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() is not null
$$;

create or replace function public.can_edit() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','editor'), false)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false)
$$;

create or replace function public.my_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.try_uuid(t text) returns uuid
language sql immutable as $$
  select case when t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then t::uuid end
$$;

-- ---------------------------------------------------------------------
-- 2. 系統設定（參數字典、預警規則）  key = 'dicts' | 'rules'
-- ---------------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. 人員與單位
-- ---------------------------------------------------------------------
create table if not exists public.people (
  id         uuid primary key default gen_random_uuid(),
  category   text not null default '內部單位' check (category in ('內部單位','外部廠商')),
  dept       text not null,
  name       text not null,
  email      text,
  factory    text,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists people_email_uniq on public.people (lower(email)) where email is not null and email <> '';

-- ---------------------------------------------------------------------
-- 4. 專案 / 大項目模塊 / 細項任務 / 執行履歷
-- ---------------------------------------------------------------------
create table if not exists public.projects (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  type                  text,
  factory               text,
  status                text not null default '進行中' check (status in ('評估中','進行中','專案完成','專案終止')),
  start_date            date,
  end_date              date,
  owner                 text,
  pm                    text,
  img_before            text,      -- Storage 路徑或外部網址
  img_after             text,
  desc_before           text,
  desc_after            text,
  hidden_modules        uuid[] not null default '{}',
  source_requirement_id uuid,
  created_by            uuid default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint projects_date_order check (end_date is null or start_date is null or end_date >= start_date)
);

-- v3.1：首頁甘特圖可個別隱藏細項
alter table public.projects add column if not exists hidden_tasks uuid[] not null default '{}';

create table if not exists public.project_modules (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  sort_order int  not null default 0,
  name       text not null,
  owner      text
);
create index if not exists project_modules_project_idx on public.project_modules(project_id);

create table if not exists public.project_tasks (
  id         uuid primary key default gen_random_uuid(),
  module_id  uuid not null references public.project_modules(id) on delete cascade,
  sort_order int  not null default 0,
  name       text not null,
  pm         text,
  owner      text,
  start_date date,
  end_date   date,
  progress   int  not null default 0 check (progress between 0 and 100)
);
create index if not exists project_tasks_module_idx on public.project_tasks(module_id);

create table if not exists public.project_records (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  record_date        date not null,
  type               text not null,
  target_module      text,
  internal_attendees text,
  external_attendees text,
  detail             text not null,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now()
);
create index if not exists project_records_project_idx on public.project_records(project_id, record_date desc);

-- ---------------------------------------------------------------------
-- 5. 項目需求評估 / 討論紀錄
-- ---------------------------------------------------------------------
create table if not exists public.requirements (
  id                uuid primary key default gen_random_uuid(),
  type              text not null,
  title             text not null,
  factory           text,
  dept              text,
  requester         text,
  status            text not null default '需求討論中'
                    check (status in ('需求討論中','現場場勘評估','方案確認成案','已轉專案','暫緩／不成案')),
  created_date      date not null default current_date,
  description       text,
  target            text,
  linked_project_id uuid references public.projects(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.requirement_discussions (
  id             uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirements(id) on delete cascade,
  disc_date      date not null,
  type           text not null,
  internal       text,
  external       text,
  content        text not null,
  created_at     timestamptz not null default now()
);
create index if not exists req_disc_req_idx on public.requirement_discussions(requirement_id, disc_date desc);

-- ---------------------------------------------------------------------
-- 5b. v4：個人專案／需求 ＋ 分享
--     • 每個專案、需求案件都有擁有者（建立的人）
--     • 擁有者可把單一專案／需求分享給指定成員：對方只能查看＋新增追蹤紀錄
--     • 追蹤紀錄（履歷／討論）只有撰寫人能修改或刪除
--     • 管理員可查看全部，但對別人的專案只有「新增追蹤」權限
-- ---------------------------------------------------------------------
alter table public.projects                add column if not exists owner_id    uuid;
alter table public.projects                add column if not exists owner_email text;
alter table public.requirements            add column if not exists owner_id    uuid;
alter table public.requirements            add column if not exists owner_email text;
alter table public.project_records         add column if not exists author_email text;
alter table public.project_records         add column if not exists updated_at  timestamptz not null default now();
alter table public.requirement_discussions add column if not exists created_by  uuid;
alter table public.requirement_discussions add column if not exists author_email text;
alter table public.requirement_discussions add column if not exists updated_at  timestamptz not null default now();
create index if not exists projects_owner_idx     on public.projects(owner_id);
create index if not exists requirements_owner_idx on public.requirements(owner_id);

create table if not exists public.project_shares (
  project_id uuid not null references public.projects(id) on delete cascade,
  email      text not null check (email = lower(email)),
  shared_by  uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (project_id, email)
);
create table if not exists public.requirement_shares (
  requirement_id uuid not null references public.requirements(id) on delete cascade,
  email          text not null check (email = lower(email)),
  shared_by      uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  primary key (requirement_id, email)
);
create index if not exists project_shares_email_idx     on public.project_shares(email);
create index if not exists requirement_shares_email_idx on public.requirement_shares(email);

-- 新增時由伺服器填入擁有者／撰寫人（前端無法偽造）
create or replace function public.set_owner() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then
    new.owner_id := auth.uid();
    new.owner_email := public.my_email();
  end if;
  return new;
end $$;
create or replace function public.set_author() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
    new.author_email := public.my_email();
  end if;
  return new;
end $$;
-- 修改時不可變更擁有者／撰寫人
create or replace function public.keep_owner() returns trigger
language plpgsql as $$
begin
  if old.owner_id is not null then new.owner_id := old.owner_id; end if;
  new.owner_email := coalesce(old.owner_email, new.owner_email);
  return new;
end $$;
create or replace function public.keep_author() returns trigger
language plpgsql as $$
begin
  if old.created_by is not null then new.created_by := old.created_by; end if;
  new.author_email := coalesce(old.author_email, new.author_email);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_set_owner  on public.projects;
drop trigger if exists trg_keep_owner on public.projects;
create trigger trg_set_owner  before insert on public.projects for each row execute function public.set_owner();
create trigger trg_keep_owner before update on public.projects for each row execute function public.keep_owner();
drop trigger if exists trg_set_owner  on public.requirements;
drop trigger if exists trg_keep_owner on public.requirements;
create trigger trg_set_owner  before insert on public.requirements for each row execute function public.set_owner();
create trigger trg_keep_owner before update on public.requirements for each row execute function public.keep_owner();
drop trigger if exists trg_set_author  on public.project_records;
drop trigger if exists trg_keep_author on public.project_records;
create trigger trg_set_author  before insert on public.project_records for each row execute function public.set_author();
create trigger trg_keep_author before update on public.project_records for each row execute function public.keep_author();
drop trigger if exists trg_set_author  on public.requirement_discussions;
drop trigger if exists trg_keep_author on public.requirement_discussions;
create trigger trg_set_author  before insert on public.requirement_discussions for each row execute function public.set_author();
create trigger trg_keep_author before update on public.requirement_discussions for each row execute function public.keep_author();

-- 權限判斷（security definer：避免政策互相引用造成遞迴）
create or replace function public.can_view_project(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member() and exists (
    select 1 from projects p where p.id = pid and (
      p.owner_id = auth.uid() or public.is_admin()
      or exists (select 1 from project_shares s where s.project_id = pid and s.email = public.my_email())))
$$;
create or replace function public.owns_project(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_edit() and exists (select 1 from projects p where p.id = pid and p.owner_id = auth.uid())
$$;
create or replace function public.can_view_requirement(rid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member() and exists (
    select 1 from requirements r where r.id = rid and (
      r.owner_id = auth.uid() or public.is_admin()
      or exists (select 1 from requirement_shares s where s.requirement_id = rid and s.email = public.my_email())))
$$;
create or replace function public.owns_requirement(rid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_edit() and exists (select 1 from requirements r where r.id = rid and r.owner_id = auth.uid())
$$;
create or replace function public.module_project(mid uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select project_id from project_modules where id = mid
$$;

-- 專案刪除時，被轉立的需求案件自動退回「方案確認成案」
create or replace function public.reset_requirement_on_project_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.requirements set status = '方案確認成案'
  where linked_project_id = old.id and status = '已轉專案';
  return old;
end $$;
drop trigger if exists trg_project_delete_req on public.projects;
create trigger trg_project_delete_req before delete on public.projects
  for each row execute function public.reset_requirement_on_project_delete();

-- updated_at 觸發器
do $$
declare t text;
begin
  foreach t in array array['people','projects','requirements','app_settings'] loop
    execute format('drop trigger if exists trg_touch on public.%I', t);
    execute format('create trigger trg_touch before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. 一次儲存整個專案（基本資料＋模塊＋細項），在同一個交易內完成
-- ---------------------------------------------------------------------
create or replace function public.save_project(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  pid uuid := coalesce(nullif(p->>'id','')::uuid, gen_random_uuid());
  m   jsonb;
  t   jsonb;
  mi  int := 0;
  ti  int;
  mid uuid;
begin
  -- 不使用 ON CONFLICT：新專案在寫入前還不存在，無法通過「看得到才能 upsert」的權限檢查
  if exists (select 1 from projects where id = pid) then
    update projects set
      name        = p->>'name',
      type        = p->>'type',
      factory     = p->>'factory',
      status      = coalesce(p->>'status','進行中'),
      start_date  = nullif(p->>'start_date','')::date,
      end_date    = nullif(p->>'end_date','')::date,
      owner       = p->>'owner',
      pm          = p->>'pm',
      img_before  = coalesce(p->>'img_before',  img_before),
      img_after   = coalesce(p->>'img_after',   img_after),
      desc_before = coalesce(p->>'desc_before', desc_before),
      desc_after  = coalesce(p->>'desc_after',  desc_after),
      hidden_modules = case when p ? 'hidden_modules' then coalesce(array(select jsonb_array_elements_text(p->'hidden_modules'))::uuid[], '{}') else hidden_modules end,
      hidden_tasks   = case when p ? 'hidden_tasks'   then coalesce(array(select jsonb_array_elements_text(p->'hidden_tasks'))::uuid[], '{}') else hidden_tasks end
    where id = pid;
    if not found then raise exception 'new row violates row-level security policy for table "projects"'; end if;
    if not public.owns_project(pid) then raise exception 'new row violates row-level security policy for table "projects"'; end if;
  else
    insert into projects (id, name, type, factory, status, start_date, end_date, owner, pm,
                          img_before, img_after, desc_before, desc_after, hidden_modules, hidden_tasks, source_requirement_id)
    values (pid, p->>'name', p->>'type', p->>'factory', coalesce(p->>'status','進行中'),
            nullif(p->>'start_date','')::date, nullif(p->>'end_date','')::date, p->>'owner', p->>'pm',
            p->>'img_before', p->>'img_after', p->>'desc_before', p->>'desc_after',
            coalesce(array(select jsonb_array_elements_text(p->'hidden_modules'))::uuid[], '{}'),
            coalesce(array(select jsonb_array_elements_text(p->'hidden_tasks'))::uuid[], '{}'),
            nullif(p->>'source_requirement_id','')::uuid);
  end if;

  if p ? 'modules' then
    delete from project_modules
     where project_id = pid
       and id not in (select (e->>'id')::uuid from jsonb_array_elements(p->'modules') e where e->>'id' is not null);

    for m in select * from jsonb_array_elements(p->'modules') loop
      mid := coalesce(nullif(m->>'id','')::uuid, gen_random_uuid());
      insert into project_modules (id, project_id, sort_order, name, owner)
      values (mid, pid, mi, m->>'name', m->>'owner')
      on conflict (id) do update set sort_order = excluded.sort_order, name = excluded.name, owner = excluded.owner;

      -- 保留細項 ID（首頁「隱藏細項」設定才不會因編輯而失效）
      delete from project_tasks
       where module_id = mid
         and id not in (select (x->>'id')::uuid from jsonb_array_elements(coalesce(m->'tasks','[]'::jsonb)) x
                         where nullif(x->>'id','') is not null);
      ti := 0;
      for t in select * from jsonb_array_elements(coalesce(m->'tasks','[]'::jsonb)) loop
        insert into project_tasks (id, module_id, sort_order, name, pm, owner, start_date, end_date, progress)
        values (coalesce(nullif(t->>'id','')::uuid, gen_random_uuid()), mid, ti, t->>'name', t->>'pm', t->>'owner',
                nullif(t->>'start_date','')::date, nullif(t->>'end_date','')::date,
                least(100, greatest(0, coalesce((t->>'progress')::int, 0))))
        on conflict (id) do update set module_id = excluded.module_id, sort_order = excluded.sort_order, name = excluded.name,
          pm = excluded.pm, owner = excluded.owner, start_date = excluded.start_date, end_date = excluded.end_date, progress = excluded.progress;
        ti := ti + 1;
      end loop;
      mi := mi + 1;
    end loop;

    -- 清掉已不存在模塊／細項的「隱藏」設定
    update projects
       set hidden_modules = coalesce(array(select h from unnest(hidden_modules) h
                                           where h in (select id from project_modules where project_id = pid)), '{}'),
           hidden_tasks   = coalesce(array(select h from unnest(hidden_tasks) h
                                           where h in (select t.id from project_tasks t join project_modules m on m.id = t.module_id
                                                        where m.project_id = pid)), '{}')
     where id = pid;
  end if;

  return pid;
end $$;

-- ---------------------------------------------------------------------
-- 7. Row Level Security
--    共用資料（人員名冊、參數設定）：成員可讀，admin / editor 可寫
--    個人資料（專案、需求）：見上方 5b 說明
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  -- 先移除舊版（v3）的通用政策
  foreach t in array array['app_settings','people','projects','project_modules','project_tasks',
                           'project_records','requirements','requirement_discussions','project_shares','requirement_shares'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "members read" on public.%I', t);
    execute format('drop policy if exists "editors insert" on public.%I', t);
    execute format('drop policy if exists "editors update" on public.%I', t);
    execute format('drop policy if exists "editors delete" on public.%I', t);
    execute format('drop policy if exists "pm select" on public.%I', t);
    execute format('drop policy if exists "pm insert" on public.%I', t);
    execute format('drop policy if exists "pm update" on public.%I', t);
    execute format('drop policy if exists "pm delete" on public.%I', t);
  end loop;
  foreach t in array array['app_settings','people'] loop
    execute format('create policy "members read"   on public.%I for select to authenticated using (public.is_member())', t);
    execute format('create policy "editors insert" on public.%I for insert to authenticated with check (public.can_edit())', t);
    execute format('create policy "editors update" on public.%I for update to authenticated using (public.can_edit()) with check (public.can_edit())', t);
    execute format('create policy "editors delete" on public.%I for delete to authenticated using (public.can_edit())', t);
  end loop;
end $$;

-- 專案：擁有者全權；被分享者／管理員只能查看
create policy "pm select" on public.projects for select to authenticated using (public.can_view_project(id));
create policy "pm insert" on public.projects for insert to authenticated with check (public.can_edit() and owner_id = auth.uid());
create policy "pm update" on public.projects for update to authenticated using (public.can_edit() and owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "pm delete" on public.projects for delete to authenticated using (public.can_edit() and owner_id = auth.uid());

create policy "pm select" on public.project_modules for select to authenticated using (public.can_view_project(project_id));
create policy "pm insert" on public.project_modules for insert to authenticated with check (public.owns_project(project_id));
create policy "pm update" on public.project_modules for update to authenticated using (public.owns_project(project_id)) with check (public.owns_project(project_id));
create policy "pm delete" on public.project_modules for delete to authenticated using (public.owns_project(project_id));

create policy "pm select" on public.project_tasks for select to authenticated using (public.can_view_project(public.module_project(module_id)));
create policy "pm insert" on public.project_tasks for insert to authenticated with check (public.owns_project(public.module_project(module_id)));
create policy "pm update" on public.project_tasks for update to authenticated using (public.owns_project(public.module_project(module_id))) with check (public.owns_project(public.module_project(module_id)));
create policy "pm delete" on public.project_tasks for delete to authenticated using (public.owns_project(public.module_project(module_id)));

-- 追蹤紀錄：看得到專案的編輯者都能新增；只有撰寫人能修改／刪除
create policy "pm select" on public.project_records for select to authenticated using (public.can_view_project(project_id));
create policy "pm insert" on public.project_records for insert to authenticated with check (public.can_edit() and public.can_view_project(project_id) and created_by = auth.uid());
create policy "pm update" on public.project_records for update to authenticated using (public.can_edit() and created_by = auth.uid()) with check (created_by = auth.uid());
create policy "pm delete" on public.project_records for delete to authenticated using (public.can_edit() and created_by = auth.uid());

-- 分享名單：擁有者管理；被分享者看得到自己那筆（也可自行退出）；管理員可看
create policy "pm select" on public.project_shares for select to authenticated
  using (public.owns_project(project_id) or email = public.my_email() or public.is_admin()
         or exists (select 1 from projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy "pm insert" on public.project_shares for insert to authenticated
  with check (public.owns_project(project_id) and email <> public.my_email());
create policy "pm delete" on public.project_shares for delete to authenticated
  using (public.owns_project(project_id) or email = public.my_email());

-- 需求評估：與專案相同規則
create policy "pm select" on public.requirements for select to authenticated using (public.can_view_requirement(id));
create policy "pm insert" on public.requirements for insert to authenticated with check (public.can_edit() and owner_id = auth.uid());
create policy "pm update" on public.requirements for update to authenticated using (public.can_edit() and owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "pm delete" on public.requirements for delete to authenticated using (public.can_edit() and owner_id = auth.uid());

create policy "pm select" on public.requirement_discussions for select to authenticated using (public.can_view_requirement(requirement_id));
create policy "pm insert" on public.requirement_discussions for insert to authenticated with check (public.can_edit() and public.can_view_requirement(requirement_id) and created_by = auth.uid());
create policy "pm update" on public.requirement_discussions for update to authenticated using (public.can_edit() and created_by = auth.uid()) with check (created_by = auth.uid());
create policy "pm delete" on public.requirement_discussions for delete to authenticated using (public.can_edit() and created_by = auth.uid());

create policy "pm select" on public.requirement_shares for select to authenticated
  using (public.owns_requirement(requirement_id) or email = public.my_email() or public.is_admin()
         or exists (select 1 from requirements r where r.id = requirement_id and r.owner_id = auth.uid()));
create policy "pm insert" on public.requirement_shares for insert to authenticated
  with check (public.owns_requirement(requirement_id) and email <> public.my_email());
create policy "pm delete" on public.requirement_shares for delete to authenticated
  using (public.owns_requirement(requirement_id) or email = public.my_email());

-- 成員名單：所有成員可查看（分享時選人用）；只有管理員能管理
alter table public.app_members enable row level security;
drop policy if exists "members see self or admin" on public.app_members;
drop policy if exists "members read members" on public.app_members;
drop policy if exists "admin manage members" on public.app_members;
create policy "members read members" on public.app_members for select to authenticated
  using (public.is_member() or email = public.my_email());
create policy "admin manage members" on public.app_members for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 未登入 (anon) 一律無權限
revoke all on all tables in schema public from anon;
grant execute on function public.my_role(), public.is_member(), public.can_edit(), public.is_admin(), public.my_email(),
                         public.can_view_project(uuid), public.owns_project(uuid), public.can_view_requirement(uuid),
                         public.owns_requirement(uuid), public.module_project(uuid), public.try_uuid(text),
                         public.save_project(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 8. 案場照片 Storage（私有 bucket，只有成員可看）
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-images', 'project-images', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "pm images read"   on storage.objects;
drop policy if exists "pm images insert" on storage.objects;
drop policy if exists "pm images update" on storage.objects;
drop policy if exists "pm images delete" on storage.objects;
-- 照片路徑為「專案ID/檔名」：看得到專案才看得到照片；只有專案擁有者能上傳／刪除
create policy "pm images read"   on storage.objects for select to authenticated
  using (bucket_id = 'project-images' and public.can_view_project(public.try_uuid(split_part(name, '/', 1))));
create policy "pm images insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'project-images' and public.owns_project(public.try_uuid(split_part(name, '/', 1))));
create policy "pm images update" on storage.objects for update to authenticated
  using (bucket_id = 'project-images' and public.owns_project(public.try_uuid(split_part(name, '/', 1))));
create policy "pm images delete" on storage.objects for delete to authenticated
  using (bucket_id = 'project-images' and public.owns_project(public.try_uuid(split_part(name, '/', 1))));

-- ---------------------------------------------------------------------
-- 9. 整理用檢視表（在 Supabase「Table Editor」可直接瀏覽、篩選、匯出 CSV）
--    security_invoker = true：檢視表一樣受上方權限保護
-- ---------------------------------------------------------------------
drop view if exists public.v_專案總表, public.v_任務明細, public.v_履歷紀錄, public.v_需求評估總表;
create or replace view public.v_專案總表 with (security_invoker = true) as
select p.name                       as 專案名稱,
       p.type                       as 類型,
       p.factory                    as 廠區,
       p.status                     as 狀態,
       p.pm                         as 負責人,
       p.owner                      as owner,
       p.start_date                 as 起始日,
       p.end_date                   as 結束日,
       (select count(*) from project_modules m where m.project_id = p.id) as 大項目數,
       (select count(*) from project_tasks t join project_modules m on m.id = t.module_id where m.project_id = p.id) as 細項數,
       (select round(avg(t.progress)) from project_tasks t join project_modules m on m.id = t.module_id where m.project_id = p.id) as 平均進度,
       (select max(r.record_date) from project_records r where r.project_id = p.id) as 最後紀錄日,
       p.owner_email as 擁有者,
       (select string_agg(s.email, ', ') from project_shares s where s.project_id = p.id) as 分享給,
       p.id
from projects p
order by p.factory, p.status, p.start_date;

create or replace view public.v_任務明細 with (security_invoker = true) as
select p.name as 專案名稱, p.factory as 廠區, p.status as 專案狀態,
       m.name as 大項目, m.owner as 大項目owner,
       t.name as 細項, t.pm as 負責人, t.owner as 驗收人,
       t.start_date as 開始, t.end_date as 結束, t.progress as 進度,
       (t.progress < 100 and t.end_date < current_date) as 已逾期
from project_tasks t
join project_modules m on m.id = t.module_id
join projects p on p.id = m.project_id
order by p.name, m.sort_order, t.sort_order;

create or replace view public.v_履歷紀錄 with (security_invoker = true) as
select r.record_date as 日期, p.name as 專案名稱, p.factory as 廠區, r.type as 類別,
       r.target_module as 模塊, r.internal_attendees as 內部與會, r.external_attendees as 外部與會, r.detail as 內容,
       r.author_email as 填寫人
from project_records r join projects p on p.id = r.project_id
order by r.record_date desc;

create or replace view public.v_需求評估總表 with (security_invoker = true) as
select q.title as 案件名稱, q.type as 類型, q.factory as 廠區, q.dept as 使用單位, q.requester as 提出人員,
       q.status as 狀態, q.created_date as 提出日期, q.description as 需求描述, q.target as 預期效益,
       (select count(*) from requirement_discussions d where d.requirement_id = q.id) as 討論次數,
       (select max(d.disc_date) from requirement_discussions d where d.requirement_id = q.id) as 最近討論日,
       p.name as 轉立專案
from requirements q left join projects p on p.id = q.linked_project_id
order by q.type, q.created_date desc;

grant select on public.v_專案總表, public.v_任務明細, public.v_履歷紀錄, public.v_需求評估總表 to authenticated;

-- ---------------------------------------------------------------------
-- 10. 預設參數
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('dicts', '{"projTypes":["AMR搬運","手臂","系統","設備改造","影像辨識"],"factories":["東莞廠","越南一廠","越南二廠","台灣廠"],"recordTypes":["當面會議","線上會議","現場場勘","資料審查整理","方案討論變動","異常狀況"]}'),
  ('rules', '{"delayDays":7,"delayHighlight":true,"staleDays":14,"weeklyEmail":false}')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 11. ★ 第一位管理員：把下面的 Email 改成你的登入 Email 後執行
-- ---------------------------------------------------------------------
-- insert into public.app_members (email, role, display_name)
-- values (lower('your-email@company.com'), 'admin', '系統管理員')
-- on conflict (email) do update set role = 'admin';

-- ---------------------------------------------------------------------
-- 12. v3 → v4 既有資料移轉（可重複執行；全新安裝時不會有任何影響）
--     專案擁有者＝原建立者；找不到建立者的資料歸給最早加入的管理員
-- ---------------------------------------------------------------------
update public.projects set owner_id = created_by where owner_id is null and created_by is not null;
update public.projects p set owner_email = lower(u.email)
  from auth.users u where p.owner_email is null and u.id = p.owner_id;
update public.project_records r set author_email = lower(u.email)
  from auth.users u where r.author_email is null and u.id = r.created_by;
with first_admin as (
  select u.id, lower(u.email) as email
  from public.app_members m join auth.users u on lower(u.email) = m.email
  where m.role = 'admin' order by m.created_at limit 1
)
update public.projects p set owner_id = fa.id, owner_email = fa.email from first_admin fa where p.owner_id is null;
with first_admin as (
  select u.id, lower(u.email) as email
  from public.app_members m join auth.users u on lower(u.email) = m.email
  where m.role = 'admin' order by m.created_at limit 1
)
update public.requirements r set owner_id = fa.id, owner_email = fa.email from first_admin fa where r.owner_id is null;
