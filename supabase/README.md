# Mizuki Supabase backend

This directory contains the external runtime backend for the static Astro site.
GitHub Pages continues to serve HTML/CSS/JavaScript; database writes are handled
by Supabase and the `blog-api` Edge Function.

No project reference, API URL, API key, service secret, or visitor hashing secret
is committed here.

## Included infrastructure

- `migrations/202607150001_blog_backend.sql`
  - `content_entries`: article and diary Markdown, metadata, publication state
  - `comments`: threaded comments with moderation state
  - `content_likes`: one like per HMAC visitor identity and content entry
  - `content_events`: deduplicated `view` and `share` events
  - `content_stats`: public aggregate counters maintained by triggers
  - `api_rate_limits`: short-lived HMAC buckets for anonymous write throttling
  - Row Level Security, least-privilege grants, indexes, triggers, and atomic RPCs
  - public-read `blog-media` Storage bucket with admin-only browser writes
- `functions/blog-api/index.ts`
  - one CORS-restricted endpoint for reads and anonymous interactions
- `migrations/202607150002_admin_dashboard.sql`
  - private moderation audit trail and 30-day service health samples
  - atomic comment moderation and a least-privilege dashboard RPC
- `migrations/202607160001_content_visibility.sql`
  - prevents anonymous REST enumeration of hidden or trashed content
  - applies the same visibility boundary to public statistics and comments
- `functions/blog-admin-api/index.ts`
  - GitHub-identity-gated moderation, operations dashboard, and health probes
  - allow-listed Supabase Metrics API fields only; raw metrics never reach the browser
- `config.toml`
  - both functions perform explicit authorization internally

## Security model

The publishable browser key is not a secret. RLS is the security boundary for
direct browser reads. The browser cannot directly insert, update, or delete rows
in any backend table.

The Edge Function uses a Supabase server secret and validates every anonymous
write. A visitor UUID is HMAC-SHA-256 hashed before it reaches PostgreSQL. A raw
IP address is used only transiently to create a separate HMAC rate-limit bucket;
it is never written to the database or logs. IP and visitor limits are checked
independently, so changing the client-controlled visitor UUID does not reset the
IP limit. IP-limit failures fail closed; comments also fail closed if either
limiter is unavailable.

Public roles can read only:

- visible `content_entries` rows whose status is `published` and publication
  time has arrived
- approved comments attached to visible published content (the `visitor_hash`
  column is not granted to public roles)
- aggregate statistics for visible published content
- files in the `blog-media` bucket

Comments are always inserted as `pending`. Likes, events, moderation, and draft
content are inaccessible to anonymous clients.

Storage writes are restricted to trusted service-role tooling. The administrator
browser never receives a server secret and does not receive a direct Storage
write policy. SVG uploads are accepted for the existing trusted content
pipeline, but they must be sanitized because SVG is an active document format.

The private administrator UI uses Supabase GitHub OAuth. Every admin request is
validated again by `auth.getUser()` inside `blog-admin-api`, then matched against
the immutable GitHub numeric provider ID in `ADMIN_GITHUB_IDS`. A hidden navbar
item is only a presentation detail; this server-side provider-ID check is the
actual authorization boundary.

Article Markdown remains GitHub's source of truth. Authenticated content actions
are sent to `blog-admin-api`; the Edge Function holds a repository-scoped GitHub
token and creates commits through the Git Data API. The browser receives article
data and Git blob/revision SHAs, but it never receives the GitHub token. Every
write uses the branch head SHA as an optimistic lock, so a stale administrator
tab cannot silently overwrite a newer commit.

The content API supports:

- `content-list`: returns all active and trashed Markdown, including bodies and
  encrypted-post passwords, only after administrator authentication
- `content-get`: returns one active or trashed Markdown entry
- `content-commit`: atomically creates one Git commit containing up to 50
  `save`, `trash`, `restore`, `delete`, or `taxonomy` operations

Soft deletion moves Markdown from `src/content/posts` to `.trash/posts` in the
same commit. Permanent deletion is accepted only for an item that was already
persisted in trash before the current request, requires `confirm: true`, and
therefore cannot be combined with the initial trash operation in one commit.
Taxonomy rename, merge, and delete operations rewrite affected Frontmatter in
one Git commit. GitHub history remains the authoritative recovery and audit
trail; a redacted commit summary is also added to `admin_audit_log` when that
database is available.

## Deploy

Install and authenticate the Supabase CLI using the official Supabase
instructions, then run from the repository root:

```powershell
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push
supabase functions deploy blog-api --no-verify-jwt
supabase functions deploy blog-admin-api --no-verify-jwt
```

Hosted Edge Functions provide `SUPABASE_URL` and server-side key variables. The
function supports the new server key forms (`SUPABASE_SECRET_KEY` or the hosted
`SUPABASE_SECRET_KEYS` map) and the legacy `SUPABASE_SERVICE_ROLE_KEY` fallback.
Do not copy any of them into a `PUBLIC_` Astro variable.

Set only non-public function configuration with the CLI or Dashboard. Use a
long, random, independently rotatable HMAC secret:

```powershell
supabase secrets set ALLOWED_ORIGINS="https://f389722475.github.io,http://localhost:4321"
supabase secrets set VISITOR_HASH_SECRET="<LONG_RANDOM_VALUE>"
supabase secrets set ADMIN_GITHUB_IDS="20443093"
supabase secrets set GITHUB_CONTENT_TOKEN="<FINE_GRAINED_CONTENTS_WRITE_TOKEN>"
supabase secrets set GITHUB_CONTENT_OWNER="f389722475"
supabase secrets set GITHUB_CONTENT_REPO="f389722475.github.io"
supabase secrets set GITHUB_CONTENT_BRANCH="main"
supabase secrets set GITHUB_CONTENT_ROOT="src/content/posts"
supabase secrets set GITHUB_CONTENT_TRASH_ROOT=".trash/posts"
supabase secrets set OPS_MONITOR_TOKEN="<INDEPENDENT_LONG_RANDOM_VALUE>"
supabase secrets set SITE_URL="https://f389722475.github.io"
```

`GITHUB_CONTENT_TOKEN` should be a fine-grained token restricted to the Pages
repository with only `Contents: Read and write`. Do not store it in GitHub Pages
variables, Astro `PUBLIC_` variables, localStorage, or browser code. If the target
branch requires pull requests, either permit this trusted token to update the
branch or configure a separate publishing branch and merge workflow.

Store the same monitor token as the masked GitHub repository secret
`OPS_MONITOR_TOKEN`. `.github/workflows/ops-monitor.yml` calls the protected
probe every ten minutes, providing real 24-hour availability and P95 latency
samples for GitHub Pages, the public Edge API, and PostgreSQL.

Optional comment CAPTCHA:

```powershell
supabase secrets set TURNSTILE_SECRET_KEY="<TURNSTILE_SERVER_SECRET>"
```

`ALLOW_NO_ORIGIN=true` can be used temporarily for non-browser smoke tests. It
should remain disabled in production. Never use `ALLOWED_ORIGINS=*`.

For local Supabase, use an ignored local environment file and explicitly send an
allowed `Origin` header:

```powershell
supabase start
supabase db reset
supabase functions serve blog-api --no-verify-jwt --env-file <IGNORED_ENV_FILE>
```

### Administrator content request contract

All requests use `POST /functions/v1/blog-admin-api`, the browser's Supabase
access token as `Authorization: Bearer <ACCESS_TOKEN>`, and an allowed `Origin`.

```json
{ "action": "content-list" }
```

The response contains `posts` and a `revision` object. Each post includes
`id`, `sha`, `slug`, all supported Frontmatter fields, `body`, and status
metadata. `id` is the path relative to the configured content root and includes
`.md`; `slug` is the desired relative path without the extension.

```json
{
  "action": "content-commit",
  "baseHeadSha": "<revision.headSha>",
  "message": "publish article",
  "operations": [
    {
      "op": "save",
      "expectedSha": "<post.sha>",
      "post": {
        "id": "guide/example.md",
        "slug": "guide/example",
        "title": "Example",
        "body": "# Example",
        "status": "published",
        "publishedAt": "2026-07-16T12:00:00.000Z",
        "tags": [],
        "kind": "article"
      }
    }
  ]
}
```

The browser should send the complete post shape returned by `content-list`;
fields omitted in the shortened example use validated defaults. A new post may
omit `id`, `sha`, and `expectedSha`. Editing should include `expectedSha`.
Changing `slug` atomically moves the Markdown file.

Other operation shapes are:

```json
{ "op": "trash", "id": "guide/example.md", "expectedSha": "<post.sha>" }
{ "op": "restore", "id": "guide/example.md", "expectedSha": "<post.sha>" }
{ "op": "delete", "id": "guide/example.md", "expectedSha": "<post.sha>", "confirm": true }
{ "op": "taxonomy", "taxonomy": "tag", "mode": "merge", "from": "old", "to": "new" }
```

On success, `content-commit` returns the new commit and a refreshed `posts`
array. A `409 CONTENT_REVISION_CONFLICT` response includes the current branch
head and requires reloading before retrying. Do not automatically retry a write
with a replaced `baseHeadSha`; the administrator must review the newer content.

## Seed or synchronize content

Interactions require a matching, published `content_entries` row. Anonymous
requests never create content automatically. This prevents arbitrary visitors
from filling the database with invented paths.

The repository includes a trusted sync command. It reads article Markdown from
`src/content/posts/**/*.md` and diary entries from `src/data/diary.json`,
upserts both kinds by `post_key`, and uploads their referenced local images to
`blog-media` with content-addressed names:

```powershell
pnpm run supabase:sync-content
```

Run `pnpm run supabase:sync-content:check` first to validate Frontmatter and
local media references without sending any network request.

It requires server-only `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Encrypted
posts keep their public metadata and explicitly configured public cover, but
upload an empty Markdown body and do not scan or expose body media mappings, so
database reads cannot bypass page encryption. Hidden articles are marked in
metadata and omitted from the public content list while their direct-link
interaction lookup remains available. The sync also mirrors `pinned`,
`priority`, and `trashed` metadata: public API lists use the same pinned-first
ordering as the static site, while an active Markdown file explicitly marked
`trashed: true` is archived instead of published. When a previously managed
Markdown or diary entry disappears from the source tree, the sync archives its
database record instead of hard-deleting comments and statistics. The GitHub
Pages deployment workflow runs this sync only after the static build has
succeeded; its server key is stored only as the masked repository secret
`SUPABASE_SECRET_KEY`. The step is enabled only when the repository variable
`SUPABASE_BACKEND_READY` is `true`, so an undeployed backend cannot break a
static Pages deployment.

The stable lookup contract is:

- `post_key`: stable Astro/content identifier
- `canonical_path`: normalized public path beginning with `/`, without query,
  hash, whitespace, or a trailing slash
- `kind`: `article` or `diary`

Minimal example for the SQL editor (replace every placeholder):

```sql
insert into public.content_entries (
  post_key,
  kind,
  canonical_path,
  title,
  summary,
  body_markdown,
  status,
  published_at
)
values (
  '<stable-post-key>',
  'article',
  '/posts/<public-slug>',
  '<title>',
  '<summary>',
  '<markdown>',
  'published',
  now()
);
```

The migration initializes the corresponding `content_stats` row automatically.
Future content-sync tooling should upsert on `post_key`, store media object paths
in `cover_object_path`/`metadata`, and never place signed URLs in permanent data.

## Endpoint

```text
POST https://<PROJECT_REF>.supabase.co/functions/v1/blog-api
Content-Type: application/json
Origin: https://f389722475.github.io
apikey: <PUBLIC_PUBLISHABLE_KEY>
```

All success responses use:

```json
{
  "ok": true,
  "data": {}
}
```

All errors use a safe public message:

```json
{
  "ok": false,
  "error": { "code": "ERROR_CODE", "message": "Public message" }
}
```

### Visitor and session IDs

Generate `visitorId` once with `crypto.randomUUID()` and retain it in browser
local storage. Generate a separate `sessionId` per browser tab/session. Clearing
storage or switching devices creates a different anonymous identity, so likes
are browser-level rather than account-level guarantees.

### Actions

The endpoint accepts both compact action names and frontend-compatible aliases:

| Canonical | Alias | Required fields | Result |
| --- | --- | --- | --- |
| `health` | `health_check` | none | fixed healthy status after a read-only database query; no row data or configuration |
| `summary` | `get_post`, `metrics` | `postKey`; optional `visitorId` | content summary, metrics, liked state, approved comments |
| `view` | `record_view` | `postKey`, `visitorId`; optional `sessionId` | deduplicated view and current metrics |
| `like` | `toggle_like` | `postKey`, `visitorId` | toggled `liked` state and metrics |
| `share` | `record_share` | `postKey`, `visitorId`, `method` | deduplicated share and metrics |
| `comment` | `submit_comment` | `postKey`, `visitorId`, `authorName`, `content` | newly queued pending comment |
| `comments` | - | `postKey`; optional `limit` | approved comments and metrics |
| `content-list` | `content_list` | optional `kind`, `limit`, `offset` | published content page |
| `content-get` | `content_get` | `postKey`; optional `visitorId` | full published Markdown and engagement |

`postKey` may be the row UUID, exact `post_key`, or normalized
`canonical_path`. Snake-case input fields are also accepted.

Example interaction request:

```json
{
  "action": "toggle_like",
  "postKey": "/posts/example",
  "visitorId": "00000000-0000-4000-8000-000000000000"
}
```

Metric responses include both convenient names (`views`, `likes`, `shares`,
`comments`) and their database-style aliases (`view_count`, `like_count`,
`share_count`, `comment_count`).

Supported share methods are `native`, `web-share`, `copy`, `copy-link`,
`clipboard`, `link`, `poster`, `qq`, `wechat`, `weibo`, `x`, `facebook`, and
`other`. Record a share only after the browser's share/copy operation succeeds.

Comment fields are trimmed and length-limited. URLs must use HTTP or HTTPS. If
`TURNSTILE_SECRET_KEY` is configured, `submit_comment` must also include
`turnstileToken`. Rendering clients must still treat comment bodies as plain text
or sanitize any Markdown output; raw HTML is not trusted.

## Administrator moderation and operations

The static `/admin/` page starts GitHub OAuth and remains data-empty until the
authenticated Supabase session passes the server-side numeric GitHub ID check.
Configure the GitHub OAuth App callback as
`https://<PROJECT_REF>.supabase.co/auth/v1/callback`, set the Supabase Auth Site
URL to the production origin, and allow the exact `/admin/` production and local
redirect URLs. After the owner completes the first OAuth login, disable new-user
signup; the server-side GitHub ID allowlist remains mandatory either way.
It provides:

- pending/approved/rejected/spam comment queues
- approve, reject, spam, and audited delete actions
- content and engagement totals
- real HTTP round-trip latency, PostgreSQL query latency, availability, and P95
- allow-listed memory, `/data` disk, database connection, load, and CPU-delta
  metrics from the privileged Supabase Metrics API

The browser cannot perform ICMP ping, so the UI deliberately labels these
values as HTTP RTT or query latency. Missing metrics render as `暂无`; the
dashboard never invents resource utilization values.

### Operations design references

The console adapts information-architecture patterns rather than copying source
code: Beszel's overview-first resource cards and history, Uptime Kuma's
status/latency/uptime/P95 model, Checkmate's incident-oriented status grouping,
and Supabase's privileged Metrics/Grafana allow-list approach. The resulting
implementation remains native to this Astro + Supabase project and keeps
missing, stale, or insufficient samples explicit.

- <https://github.com/henrygd/beszel>
- <https://github.com/louislam/uptime-kuma>
- <https://github.com/bluewave-labs/Checkmate>
- <https://supabase.com/docs/guides/telemetry/metrics>
- <https://github.com/supabase/supabase-grafana>

The authenticated dashboard is the preferred moderation path. Emergency SQL
moderation remains possible:

Approve a reviewed comment through the Dashboard or trusted SQL:

```sql
update public.comments
set status = 'approved'
where id = '<COMMENT_UUID>' and status = 'pending';
```

The comment counter changes only when a comment enters or leaves `approved`.
Like and event counters are transactionally updated by triggers. The public
client must never submit or calculate counter values.

Old soft-rate-limit buckets may be deleted periodically:

```sql
delete from public.api_rate_limits
where window_started_at < now() - interval '2 days';
```

Back up the database and Storage bucket before destructive schema or media
changes.
