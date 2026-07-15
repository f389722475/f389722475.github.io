begin;

-- Moderation metadata is kept on the comment itself so the queue can show who
-- made the last decision.  The immutable provider id is also copied to the
-- private audit log before destructive operations.
alter table public.comments
	add column if not exists moderated_at timestamptz,
	add column if not exists moderated_by uuid references auth.users(id) on delete set null,
	add column if not exists moderation_note text;

do $$
begin
	if not exists (
		select 1
		from pg_catalog.pg_constraint
		where conname = 'comments_moderation_note_length'
			and conrelid = 'public.comments'::regclass
	) then
		alter table public.comments
			add constraint comments_moderation_note_length
			check (
				moderation_note is null
				or char_length(moderation_note) <= 500
			);
	end if;
end
$$;

-- The original index begins with content_id and cannot serve a global pending
-- queue efficiently.
create index if not exists comments_moderation_queue_idx
	on public.comments (created_at, id)
	where status = 'pending';
create index if not exists comments_status_created_desc_idx
	on public.comments (status, created_at desc, id desc);

create table if not exists public.admin_audit_log (
	id bigint generated always as identity primary key,
	actor_user_id uuid references auth.users(id) on delete set null,
	actor_provider text not null,
	actor_provider_id text not null,
	action text not null,
	target_type text not null,
	target_id text not null,
	old_status text,
	new_status text,
	details jsonb not null default '{}'::jsonb,
	request_id uuid not null default gen_random_uuid(),
	created_at timestamptz not null default clock_timestamp(),
	constraint admin_audit_actor_provider_length
		check (char_length(actor_provider) between 1 and 40),
	constraint admin_audit_actor_provider_id_length
		check (char_length(actor_provider_id) between 1 and 200),
	constraint admin_audit_action_length
		check (char_length(action) between 1 and 80),
	constraint admin_audit_target_type_length
		check (char_length(target_type) between 1 and 80),
	constraint admin_audit_target_id_length
		check (char_length(target_id) between 1 and 500),
	constraint admin_audit_details_object
		check (jsonb_typeof(details) = 'object')
);

create index if not exists admin_audit_log_created_idx
	on public.admin_audit_log (created_at desc, id desc);
create index if not exists admin_audit_log_target_idx
	on public.admin_audit_log (target_type, target_id, created_at desc);

-- One probe batch creates one row per independently checked service.  Metrics
-- contains only a small allow-listed snapshot; credentials and raw responses
-- must never be stored here.
create table if not exists public.ops_health_samples (
	id bigint generated always as identity primary key,
	batch_id uuid not null,
	service text not null check (service in ('site', 'blog-api', 'database')),
	status text not null check (status in ('up', 'degraded', 'down')),
	latency_ms numeric(12, 3)
		check (latency_ms is null or latency_ms between 0 and 600000),
	http_status smallint
		check (http_status is null or http_status between 100 and 599),
	metrics jsonb not null default '{}'::jsonb,
	checked_at timestamptz not null default clock_timestamp(),
	constraint ops_health_metrics_object
		check (jsonb_typeof(metrics) = 'object'),
	unique (batch_id, service)
);

create index if not exists ops_health_samples_service_checked_idx
	on public.ops_health_samples (service, checked_at desc, id desc);
create index if not exists ops_health_samples_checked_idx
	on public.ops_health_samples (checked_at desc);

-- Atomic moderation plus audit.  The Edge Function supplies actor fields only
-- after validating the Supabase session and immutable GitHub provider_id.
create or replace function public.blog_admin_moderate_comment(
	p_comment_id uuid,
	p_decision text,
	p_actor_user_id uuid,
	p_actor_provider text,
	p_actor_provider_id text,
	p_note text default null,
	p_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	decision text := lower(btrim(p_decision));
	note text := nullif(btrim(p_note), '');
	old_comment public.comments%rowtype;
	new_comment public.comments%rowtype;
	next_status text;
	status_counts jsonb;
begin
	if decision not in ('approve', 'reject', 'spam', 'delete') then
		raise exception 'Unsupported moderation decision' using errcode = '22023';
	end if;
	if p_actor_user_id is null
		or btrim(p_actor_provider) = ''
		or btrim(p_actor_provider_id) = '' then
		raise exception 'Moderation actor is required' using errcode = '22023';
	end if;
	if note is not null and char_length(note) > 500 then
		raise exception 'Moderation note is too long' using errcode = '22023';
	end if;

	select c.*
	into old_comment
	from public.comments as c
	where c.id = p_comment_id
	for update;

	if not found then
		raise exception 'Comment not found' using errcode = 'P0002';
	end if;

	if decision = 'delete' then
		insert into public.admin_audit_log (
			actor_user_id,
			actor_provider,
			actor_provider_id,
			action,
			target_type,
			target_id,
			old_status,
			new_status,
			details,
			request_id
		)
		values (
			p_actor_user_id,
			btrim(p_actor_provider),
			btrim(p_actor_provider_id),
			'comment.delete',
			'comment',
			old_comment.id::text,
			old_comment.status,
			null,
			jsonb_build_object(
				'note', note,
				'comment', to_jsonb(old_comment) - 'visitor_hash'
			),
			p_request_id
		);

		delete from public.comments where id = old_comment.id;
	else
		next_status = case decision
			when 'approve' then 'approved'
			when 'reject' then 'rejected'
			else 'spam'
		end;

		update public.comments
		set
			status = next_status,
			moderated_at = clock_timestamp(),
			moderated_by = p_actor_user_id,
			moderation_note = note
		where id = old_comment.id
		returning * into new_comment;

		insert into public.admin_audit_log (
			actor_user_id,
			actor_provider,
			actor_provider_id,
			action,
			target_type,
			target_id,
			old_status,
			new_status,
			details,
			request_id
		)
		values (
			p_actor_user_id,
			btrim(p_actor_provider),
			btrim(p_actor_provider_id),
			'comment.' || decision,
			'comment',
			old_comment.id::text,
			old_comment.status,
			new_comment.status,
			jsonb_build_object('note', note),
			p_request_id
		);
	end if;

	select jsonb_build_object(
		'pending', count(*) filter (where c.status = 'pending'),
		'approved', count(*) filter (where c.status = 'approved'),
		'rejected', count(*) filter (where c.status = 'rejected'),
		'spam', count(*) filter (where c.status = 'spam'),
		'all', count(*)
	)
	into status_counts
	from public.comments as c;

	return jsonb_build_object(
		'comment_id', old_comment.id,
		'decision', decision,
		'status', case when decision = 'delete' then null else new_comment.status end,
		'deleted', decision = 'delete',
		'moderated_at', case
			when decision = 'delete' then clock_timestamp()
			else new_comment.moderated_at
		end,
		'counts', status_counts
	);
end;
$$;

-- A single narrow RPC gives the admin Edge Function the application/database
-- aggregates it cannot obtain safely through the public API.  Host CPU/memory
-- and filesystem metrics come from Supabase's privileged Metrics API instead.
create or replace function public.blog_admin_dashboard()
returns jsonb
language sql
security definer
set search_path = ''
as $$
	with content_counts as (
		select
			count(*) filter (where e.kind = 'article') as articles,
			count(*) filter (where e.kind = 'diary') as diaries,
			count(*) filter (where e.status = 'published') as published,
			count(*) filter (where e.status = 'draft') as drafts
		from public.content_entries as e
	), engagement_counts as (
		select
			coalesce(sum(s.view_count), 0)::bigint as views,
			coalesce(sum(s.like_count), 0)::bigint as likes,
			coalesce(sum(s.share_count), 0)::bigint as shares,
			coalesce(sum(s.comment_count), 0)::bigint as comments
		from public.content_stats as s
	), comment_counts as (
		select
			count(*) filter (where c.status = 'pending') as pending,
			count(*) filter (where c.status = 'approved') as approved,
			count(*) filter (where c.status = 'rejected') as rejected,
			count(*) filter (where c.status = 'spam') as spam,
			min(c.created_at) filter (where c.status = 'pending') as oldest_pending_at
		from public.comments as c
	), database_stats as (
		select
			pg_catalog.pg_database_size(pg_catalog.current_database())::bigint as size_bytes,
			coalesce((
				select count(*)
				from pg_catalog.pg_stat_activity as a
				where a.datname = pg_catalog.current_database()
					and a.backend_type = 'client backend'
			), 0)::bigint as connections,
			pg_catalog.current_setting('max_connections')::integer as max_connections,
			coalesce((
				select round(
					100.0 * d.blks_hit / nullif(d.blks_hit + d.blks_read, 0),
					2
				)
				from pg_catalog.pg_stat_database as d
				where d.datname = pg_catalog.current_database()
			), 0) as cache_hit_percent,
			case
				when pg_catalog.current_setting('default_transaction_read_only') = 'on'
					then 'read-only'
				else 'read-write'
			end as status
	), storage_stats as (
		select
			count(*)::bigint as objects,
			coalesce(sum(
				case
					when o.metadata ->> 'size' ~ '^[0-9]+$'
						then (o.metadata ->> 'size')::bigint
					else 0
				end
			), 0)::bigint as size_bytes
		from storage.objects as o
		where o.bucket_id = 'blog-media'
	), health_by_service as (
		select
			h.service,
			count(*)::integer as samples,
			round(
				100.0 * count(*) filter (where h.status <> 'down')
				/ nullif(count(*), 0),
				2
			) as uptime_percent,
			round((
				percentile_cont(0.95) within group (order by h.latency_ms)
					filter (where h.latency_ms is not null)
			)::numeric, 2) as p95_latency_ms
		from public.ops_health_samples as h
		where h.checked_at >= clock_timestamp() - interval '24 hours'
		group by h.service
	), health_summary as (
		select coalesce(
			jsonb_object_agg(
				h.service,
				jsonb_build_object(
					'samples', h.samples,
					'uptime_percent', h.uptime_percent,
					'p95_latency_ms', h.p95_latency_ms
				)
			),
			'{}'::jsonb
		) as value
		from health_by_service as h
	)
	select jsonb_build_object(
		'generated_at', clock_timestamp(),
		'content', jsonb_build_object(
			'articles', cc.articles,
			'diaries', cc.diaries,
			'published', cc.published,
			'drafts', cc.drafts,
			'views', ec.views,
			'likes', ec.likes,
			'shares', ec.shares,
			'comments', ec.comments
		),
		'comments', jsonb_build_object(
			'pending', cm.pending,
			'approved', cm.approved,
			'rejected', cm.rejected,
			'spam', cm.spam,
			'oldest_pending_at', cm.oldest_pending_at
		),
		'database', jsonb_build_object(
			'size_bytes', db.size_bytes,
			'connections', db.connections,
			'max_connections', db.max_connections,
			'connection_percent', round(
				100.0 * db.connections / nullif(db.max_connections, 0),
				2
			),
			'cache_hit_percent', db.cache_hit_percent,
			'status', db.status
		),
		'storage', jsonb_build_object(
			'objects', st.objects,
			'size_bytes', st.size_bytes
		),
		'health_24h', hs.value
	)
	from content_counts as cc
	cross join engagement_counts as ec
	cross join comment_counts as cm
	cross join database_stats as db
	cross join storage_stats as st
	cross join health_summary as hs;
$$;

-- Private operational tables deliberately have no anon/authenticated policy.
revoke all on table public.admin_audit_log from public, anon, authenticated;
revoke all on table public.ops_health_samples from public, anon, authenticated;
grant all on table public.admin_audit_log to service_role;
grant all on table public.ops_health_samples to service_role;
grant usage, select on sequence public.admin_audit_log_id_seq to service_role;
grant usage, select on sequence public.ops_health_samples_id_seq to service_role;

alter table public.admin_audit_log enable row level security;
alter table public.ops_health_samples enable row level security;
alter table public.admin_audit_log force row level security;
alter table public.ops_health_samples force row level security;

revoke execute on function public.blog_admin_moderate_comment(
	uuid, text, uuid, text, text, text, uuid
) from public, anon, authenticated;
revoke execute on function public.blog_admin_dashboard()
	from public, anon, authenticated;
grant execute on function public.blog_admin_moderate_comment(
	uuid, text, uuid, text, text, text, uuid
) to service_role;
grant execute on function public.blog_admin_dashboard() to service_role;

-- All authenticated media mutations now go through the provider-id-gated
-- admin Edge Function.  The public read policy remains unchanged.
drop policy if exists "Admins can upload blog media" on storage.objects;
drop policy if exists "Admins can update blog media" on storage.objects;
drop policy if exists "Admins can delete blog media" on storage.objects;

commit;
