begin;

-- Core content stored by Supabase. `post_key` is the stable identifier used by
-- the static Astro frontend; `canonical_path` is the public URL path.
create table if not exists public.content_entries (
	id uuid primary key default gen_random_uuid(),
	post_key text not null unique,
	kind text not null check (kind in ('article', 'diary')),
	canonical_path text not null unique,
	title text not null,
	summary text not null default '',
	body_markdown text not null default '',
	cover_object_path text,
	tags text[] not null default '{}'::text[],
	category text,
	status text not null default 'draft'
		check (status in ('draft', 'published', 'archived')),
	comment_enabled boolean not null default true,
	published_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	metadata jsonb not null default '{}'::jsonb,
	constraint content_entries_post_key_length
		check (
			char_length(post_key) between 1 and 200
			and post_key !~ '[?#[:space:]]'
		),
	constraint content_entries_canonical_path_format
		check (
			char_length(canonical_path) between 1 and 500
			and canonical_path like '/%'
			and canonical_path !~ '[?#[:space:]]'
			and (canonical_path = '/' or canonical_path !~ '/$')
		),
	constraint content_entries_title_length
		check (char_length(btrim(title)) between 1 and 200),
	constraint content_entries_summary_length
		check (char_length(summary) <= 1000),
	constraint content_entries_body_size
		check (octet_length(body_markdown) <= 4194304),
	constraint content_entries_cover_path_length
		check (
			cover_object_path is null
			or char_length(cover_object_path) between 1 and 1000
		),
	constraint content_entries_category_length
		check (category is null or char_length(category) <= 100),
	constraint content_entries_metadata_object
		check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.content_stats (
	content_id uuid primary key references public.content_entries(id) on delete cascade,
	view_count bigint not null default 0 check (view_count >= 0),
	like_count bigint not null default 0 check (like_count >= 0),
	share_count bigint not null default 0 check (share_count >= 0),
	comment_count bigint not null default 0 check (comment_count >= 0),
	updated_at timestamptz not null default now()
);

create table if not exists public.comments (
	id uuid primary key default gen_random_uuid(),
	content_id uuid not null references public.content_entries(id) on delete cascade,
	parent_id uuid references public.comments(id) on delete set null,
	author_name text not null,
	author_website text,
	body text not null,
	status text not null default 'pending'
		check (status in ('pending', 'approved', 'rejected', 'spam')),
	visitor_hash text not null,
	approved_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint comments_author_name_length
		check (char_length(btrim(author_name)) between 1 and 60),
	constraint comments_author_website_length
		check (author_website is null or char_length(author_website) <= 500),
	constraint comments_body_length
		check (char_length(btrim(body)) between 1 and 5000),
	constraint comments_visitor_hash_format
		check (visitor_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.content_likes (
	content_id uuid not null references public.content_entries(id) on delete cascade,
	visitor_hash text not null,
	created_at timestamptz not null default now(),
	primary key (content_id, visitor_hash),
	constraint content_likes_visitor_hash_format
		check (visitor_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.content_events (
	id bigint generated always as identity primary key,
	content_id uuid not null references public.content_entries(id) on delete cascade,
	event_type text not null check (event_type in ('view', 'share')),
	channel text,
	visitor_hash text not null,
	event_key text not null,
	created_at timestamptz not null default now(),
	constraint content_events_channel_length
		check (channel is null or char_length(channel) between 1 and 40),
	constraint content_events_share_channel
		check (
			(event_type = 'view' and channel is null)
			or (event_type = 'share' and channel is not null)
		),
	constraint content_events_visitor_hash_format
		check (visitor_hash ~ '^[0-9a-f]{64}$'),
	constraint content_events_event_key_format
		check (event_key ~ '^[0-9a-f]{64}$'),
	unique (content_id, event_type, event_key)
);

-- Only HMAC digests are stored here. The application never persists raw IPs.
create table if not exists public.api_rate_limits (
	bucket_key text not null,
	action text not null,
	window_started_at timestamptz not null,
	request_count integer not null default 1 check (request_count > 0),
	updated_at timestamptz not null default now(),
	primary key (bucket_key, action, window_started_at),
	constraint api_rate_limits_bucket_key_format
		check (bucket_key ~ '^[0-9a-f]{64}$'),
	constraint api_rate_limits_action_length
		check (char_length(action) between 1 and 40)
);

create index if not exists content_entries_public_listing_idx
	on public.content_entries (kind, published_at desc)
	where status = 'published';
create index if not exists content_entries_status_updated_idx
	on public.content_entries (status, updated_at desc);
create index if not exists content_entries_tags_idx
	on public.content_entries using gin (tags);
create index if not exists comments_content_status_created_idx
	on public.comments (content_id, status, created_at);
create index if not exists comments_parent_created_idx
	on public.comments (parent_id, created_at)
	where parent_id is not null;
create index if not exists content_events_content_type_created_idx
	on public.content_events (content_id, event_type, created_at desc);
create index if not exists content_events_visitor_created_idx
	on public.content_events (visitor_hash, created_at desc);
create index if not exists api_rate_limits_cleanup_idx
	on public.api_rate_limits (window_started_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	new.updated_at = clock_timestamp();
	return new;
end;
$$;

create or replace function public.prepare_content_entry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	new.post_key = btrim(new.post_key);
	new.canonical_path = btrim(new.canonical_path);
	if char_length(new.canonical_path) > 1 then
		new.canonical_path = regexp_replace(new.canonical_path, '/+$', '');
	end if;
	new.title = btrim(new.title);

	if new.status = 'published' and new.published_at is null then
		new.published_at = clock_timestamp();
	end if;

	new.updated_at = clock_timestamp();
	return new;
end;
$$;

create or replace function public.prepare_comment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
	parent_content_id uuid;
begin
	new.author_name = btrim(new.author_name);
	new.body = btrim(new.body);
	new.author_website = nullif(btrim(new.author_website), '');
	new.updated_at = clock_timestamp();

	if new.parent_id is not null then
		if new.parent_id = new.id then
			raise exception 'A comment cannot be its own parent';
		end if;

		select c.content_id
		into parent_content_id
		from public.comments as c
		where c.id = new.parent_id;

		if parent_content_id is null or parent_content_id <> new.content_id then
			raise exception 'Comment parent must belong to the same content entry';
		end if;
	end if;

	if new.status = 'approved' then
		if tg_op = 'INSERT' or old.status <> 'approved' or new.approved_at is null then
			new.approved_at = clock_timestamp();
		end if;
	else
		new.approved_at = null;
	end if;

	return new;
end;
$$;

drop trigger if exists content_entries_prepare on public.content_entries;
create trigger content_entries_prepare
	before insert or update on public.content_entries
	for each row execute function public.prepare_content_entry();

drop trigger if exists content_stats_touch_updated_at on public.content_stats;
create trigger content_stats_touch_updated_at
	before update on public.content_stats
	for each row execute function public.set_updated_at();

drop trigger if exists comments_prepare on public.comments;
create trigger comments_prepare
	before insert or update on public.comments
	for each row execute function public.prepare_comment();

create or replace function public.initialize_content_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	insert into public.content_stats (content_id)
	values (new.id)
	on conflict (content_id) do nothing;
	return new;
end;
$$;

drop trigger if exists content_entries_initialize_stats on public.content_entries;
create trigger content_entries_initialize_stats
	after insert on public.content_entries
	for each row execute function public.initialize_content_stats();

insert into public.content_stats (content_id)
select e.id
from public.content_entries as e
on conflict (content_id) do nothing;

create or replace function public.sync_like_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	if tg_op = 'INSERT' then
		update public.content_stats
		set like_count = like_count + 1
		where content_id = new.content_id;
		return new;
	end if;

	update public.content_stats
	set like_count = greatest(0, like_count - 1)
	where content_id = old.content_id;
	return old;
end;
$$;

drop trigger if exists content_likes_sync_stats on public.content_likes;
create trigger content_likes_sync_stats
	after insert or delete on public.content_likes
	for each row execute function public.sync_like_stats();

create or replace function public.sync_event_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
	delta integer;
	event_content_id uuid;
	event_name text;
begin
	if tg_op = 'INSERT' then
		delta = 1;
		event_content_id = new.content_id;
		event_name = new.event_type;
	else
		delta = -1;
		event_content_id = old.content_id;
		event_name = old.event_type;
	end if;

	if event_name = 'view' then
		update public.content_stats
		set view_count = greatest(0, view_count + delta)
		where content_id = event_content_id;
	else
		update public.content_stats
		set share_count = greatest(0, share_count + delta)
		where content_id = event_content_id;
	end if;

	if tg_op = 'INSERT' then
		return new;
	end if;
	return old;
end;
$$;

drop trigger if exists content_events_sync_stats on public.content_events;
create trigger content_events_sync_stats
	after insert or delete on public.content_events
	for each row execute function public.sync_event_stats();

create or replace function public.sync_comment_stats()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
	delta integer := 0;
	target_content_id uuid;
begin
	if tg_op = 'INSERT' then
		target_content_id = new.content_id;
		if new.status = 'approved' then
			delta = 1;
		end if;
	elsif tg_op = 'DELETE' then
		target_content_id = old.content_id;
		if old.status = 'approved' then
			delta = -1;
		end if;
	else
		target_content_id = new.content_id;
		if old.status <> 'approved' and new.status = 'approved' then
			delta = 1;
		elsif old.status = 'approved' and new.status <> 'approved' then
			delta = -1;
		end if;
	end if;

	if delta <> 0 then
		update public.content_stats
		set comment_count = greatest(0, comment_count + delta)
		where content_id = target_content_id;
	end if;

	if tg_op = 'DELETE' then
		return old;
	end if;
	return new;
end;
$$;

drop trigger if exists comments_sync_stats on public.comments;
create trigger comments_sync_stats
	after insert or delete or update of status on public.comments
	for each row execute function public.sync_comment_stats();

-- Atomic helpers are callable only by the server role used by the Edge Function.
create or replace function public.blog_toggle_like(
	p_content_id uuid,
	p_visitor_hash text
)
returns table (
	liked boolean,
	view_count bigint,
	like_count bigint,
	share_count bigint,
	comment_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
	is_liked boolean;
begin
	if p_visitor_hash !~ '^[0-9a-f]{64}$' then
		raise exception 'Invalid visitor hash';
	end if;

	if not exists (
		select 1
		from public.content_entries as e
		where e.id = p_content_id
			and e.status = 'published'
			and e.published_at <= now()
	) then
		raise exception 'Published content not found' using errcode = 'P0002';
	end if;

	perform pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(p_content_id::text || ':' || p_visitor_hash, 0)
	);

	delete from public.content_likes
	where content_id = p_content_id and visitor_hash = p_visitor_hash;

	if found then
		is_liked = false;
	else
		insert into public.content_likes (content_id, visitor_hash)
		values (p_content_id, p_visitor_hash);
		is_liked = true;
	end if;

	return query
	select
		is_liked,
		s.view_count,
		s.like_count,
		s.share_count,
		s.comment_count
	from public.content_stats as s
	where s.content_id = p_content_id;
end;
$$;

create or replace function public.blog_record_event(
	p_content_id uuid,
	p_event_type text,
	p_visitor_hash text,
	p_event_key text,
	p_channel text default null
)
returns table (
	recorded boolean,
	view_count bigint,
	like_count bigint,
	share_count bigint,
	comment_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
	inserted_id bigint;
begin
	if p_event_type not in ('view', 'share') then
		raise exception 'Invalid event type';
	end if;
	if p_visitor_hash !~ '^[0-9a-f]{64}$' or p_event_key !~ '^[0-9a-f]{64}$' then
		raise exception 'Invalid event identity';
	end if;
	if (p_event_type = 'view' and p_channel is not null)
		or (p_event_type = 'share' and p_channel is null) then
		raise exception 'Invalid event channel';
	end if;

	if not exists (
		select 1
		from public.content_entries as e
		where e.id = p_content_id
			and e.status = 'published'
			and e.published_at <= now()
	) then
		raise exception 'Published content not found' using errcode = 'P0002';
	end if;

	insert into public.content_events (
		content_id,
		event_type,
		channel,
		visitor_hash,
		event_key
	)
	values (
		p_content_id,
		p_event_type,
		p_channel,
		p_visitor_hash,
		p_event_key
	)
	on conflict (content_id, event_type, event_key) do nothing
	returning id into inserted_id;

	return query
	select
		inserted_id is not null,
		s.view_count,
		s.like_count,
		s.share_count,
		s.comment_count
	from public.content_stats as s
	where s.content_id = p_content_id;
end;
$$;

create or replace function public.blog_check_rate_limit(
	p_bucket_key text,
	p_action text,
	p_window_seconds integer,
	p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	window_start timestamptz;
	current_count integer;
begin
	if p_bucket_key !~ '^[0-9a-f]{64}$'
		or char_length(p_action) not between 1 and 40
		or p_window_seconds not between 1 and 86400
		or p_limit not between 1 and 10000 then
		return false;
	end if;

	window_start = pg_catalog.to_timestamp(
		floor(extract(epoch from clock_timestamp()) / p_window_seconds)
		* p_window_seconds
	);

	insert into public.api_rate_limits as current_bucket (
		bucket_key,
		action,
		window_started_at,
		request_count
	)
	values (p_bucket_key, p_action, window_start, 1)
	on conflict (bucket_key, action, window_started_at)
	do update set
		request_count = current_bucket.request_count + 1,
		updated_at = clock_timestamp()
	returning request_count into current_count;

	-- Opportunistic cleanup keeps the soft limiter bounded without a cron job.
	if pg_catalog.random() < 0.01 then
		delete from public.api_rate_limits
		where window_started_at < clock_timestamp() - interval '2 days';
	end if;

	return current_count <= p_limit;
end;
$$;

-- Restrict all direct table access first, then grant only published/approved reads.
revoke all on table public.content_entries from anon, authenticated;
revoke all on table public.content_stats from anon, authenticated;
revoke all on table public.comments from anon, authenticated;
revoke all on table public.content_likes from anon, authenticated;
revoke all on table public.content_events from anon, authenticated;
revoke all on table public.api_rate_limits from anon, authenticated;

grant select on table public.content_entries to anon, authenticated;
grant select on table public.content_stats to anon, authenticated;
grant select (
	id,
	content_id,
	parent_id,
	author_name,
	author_website,
	body,
	status,
	approved_at,
	created_at,
	updated_at
) on public.comments to anon, authenticated;

grant all on table public.content_entries to service_role;
grant all on table public.content_stats to service_role;
grant all on table public.comments to service_role;
grant all on table public.content_likes to service_role;
grant all on table public.content_events to service_role;
grant all on table public.api_rate_limits to service_role;
grant usage, select on all sequences in schema public to service_role;

alter table public.content_entries enable row level security;
alter table public.content_stats enable row level security;
alter table public.comments enable row level security;
alter table public.content_likes enable row level security;
alter table public.content_events enable row level security;
alter table public.api_rate_limits enable row level security;

drop policy if exists "Published content is publicly readable" on public.content_entries;
create policy "Published content is publicly readable"
	on public.content_entries
	for select
	to anon, authenticated
	using (status = 'published' and published_at <= now());

drop policy if exists "Published content stats are publicly readable" on public.content_stats;
create policy "Published content stats are publicly readable"
	on public.content_stats
	for select
	to anon, authenticated
	using (
		exists (
			select 1
			from public.content_entries as e
			where e.id = public.content_stats.content_id
				and e.status = 'published'
				and e.published_at <= now()
		)
	);

drop policy if exists "Approved comments are publicly readable" on public.comments;
create policy "Approved comments are publicly readable"
	on public.comments
	for select
	to anon, authenticated
	using (
		status = 'approved'
		and exists (
			select 1
			from public.content_entries as e
			where e.id = public.comments.content_id
				and e.status = 'published'
				and e.published_at <= now()
		)
	);

revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.prepare_content_entry() from public, anon, authenticated;
revoke execute on function public.prepare_comment() from public, anon, authenticated;
revoke execute on function public.initialize_content_stats() from public, anon, authenticated;
revoke execute on function public.sync_like_stats() from public, anon, authenticated;
revoke execute on function public.sync_event_stats() from public, anon, authenticated;
revoke execute on function public.sync_comment_stats() from public, anon, authenticated;
revoke execute on function public.blog_toggle_like(uuid, text) from public, anon, authenticated;
revoke execute on function public.blog_record_event(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.blog_check_rate_limit(text, text, integer, integer) from public, anon, authenticated;

grant execute on function public.blog_toggle_like(uuid, text) to service_role;
grant execute on function public.blog_record_event(uuid, text, text, text, text) to service_role;
grant execute on function public.blog_check_rate_limit(text, text, integer, integer) to service_role;

-- Public media is readable by URL. Upload/update/delete requires an authenticated
-- user whose immutable app_metadata role is `admin`, or a server secret.
insert into storage.buckets (
	id,
	name,
	public,
	file_size_limit,
	allowed_mime_types
)
values (
	'blog-media',
	'blog-media',
	true,
	10485760,
	array[
		'image/avif',
		'image/gif',
		'image/jpeg',
		'image/png',
		'image/svg+xml',
		'image/webp'
	]
)
on conflict (id) do update set
	name = excluded.name,
	public = excluded.public,
	file_size_limit = excluded.file_size_limit,
	allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can read blog media" on storage.objects;
create policy "Public can read blog media"
	on storage.objects
	for select
	to public
	using (bucket_id = 'blog-media');

drop policy if exists "Admins can upload blog media" on storage.objects;
create policy "Admins can upload blog media"
	on storage.objects
	for insert
	to authenticated
	with check (
		bucket_id = 'blog-media'
		and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
	);

drop policy if exists "Admins can update blog media" on storage.objects;
create policy "Admins can update blog media"
	on storage.objects
	for update
	to authenticated
	using (
		bucket_id = 'blog-media'
		and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
	)
	with check (
		bucket_id = 'blog-media'
		and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
	);

drop policy if exists "Admins can delete blog media" on storage.objects;
create policy "Admins can delete blog media"
	on storage.objects
	for delete
	to authenticated
	using (
		bucket_id = 'blog-media'
		and coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
	);

commit;
