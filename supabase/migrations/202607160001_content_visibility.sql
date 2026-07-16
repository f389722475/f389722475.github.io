begin;

-- Hidden posts remain available through the service-role Edge API when their
-- direct URL is known, but public REST roles must not be able to enumerate
-- their metadata, comments, or aggregate statistics.
drop policy if exists "Published content is publicly readable" on public.content_entries;
create policy "Published content is publicly readable"
	on public.content_entries
	for select
	to anon, authenticated
	using (
		status = 'published'
		and published_at <= now()
		and (metadata ->> 'hidden') is distinct from 'true'
		and (metadata ->> 'trashed') is distinct from 'true'
	);

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
				and (e.metadata ->> 'hidden') is distinct from 'true'
				and (e.metadata ->> 'trashed') is distinct from 'true'
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
				and (e.metadata ->> 'hidden') is distinct from 'true'
				and (e.metadata ->> 'trashed') is distinct from 'true'
		)
	);

commit;
