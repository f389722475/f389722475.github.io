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
- `config.toml`
  - deploys `blog-api` with JWT verification disabled because the public site has
    no user login; all write authorization is performed inside the function

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

- `content_entries` rows whose status is `published` and publication time has
  arrived
- approved comments attached to published content (the `visitor_hash` column is
  not granted to public roles)
- aggregate statistics for published content
- files in the `blog-media` bucket

Comments are always inserted as `pending`. Likes, events, moderation, and draft
content are inaccessible to anonymous clients.

Storage uploads from a browser additionally require an authenticated user with
`app_metadata.role = "admin"`. Until an admin login is added, upload through the
Supabase Dashboard or trusted server tooling. SVG uploads are accepted for the
existing content pipeline, but they must come from a trusted administrator and
be sanitized before upload because SVG is an active document format.

## Deploy

Install and authenticate the Supabase CLI using the official Supabase
instructions, then run from the repository root:

```powershell
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push
supabase functions deploy blog-api --no-verify-jwt
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
```

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
database reads cannot bypass page encryption. The command never deletes remote
content. The GitHub Pages deployment workflow runs this sync only after the
static build has succeeded; its server key is stored only as the masked
repository secret
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

## Moderation and maintenance

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
