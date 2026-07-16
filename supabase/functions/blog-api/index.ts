import {
	createClient,
	type SupabaseClient,
} from "npm:@supabase/supabase-js@2.95.0";

type JsonObject = Record<string, unknown>;
type CanonicalAction =
	| "health"
	| "summary"
	| "view"
	| "like"
	| "share"
	| "comment"
	| "comments"
	| "content-list"
	| "content-get";

interface ContentRow {
	id: string;
	post_key: string;
	kind: "article" | "diary";
	canonical_path: string;
	title: string;
	summary: string;
	body_markdown?: string;
	cover_object_path: string | null;
	tags: string[];
	category: string | null;
	comment_enabled: boolean;
	published_at: string;
	created_at: string;
	updated_at: string;
	metadata?: JsonObject;
}

interface MetricRow {
	view_count?: number | string | null;
	like_count?: number | string | null;
	share_count?: number | string | null;
	comment_count?: number | string | null;
}

interface CommentRow {
	id: string;
	content_id: string;
	parent_id: string | null;
	author_name: string;
	author_website: string | null;
	body: string;
	status: "pending" | "approved" | "rejected" | "spam";
	created_at: string;
	updated_at: string;
}

const MAX_BODY_BYTES = 32 * 1024;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTENT_SUMMARY_FIELDS: string =
	"id,post_key,kind,canonical_path,title,summary,cover_object_path,tags,category,comment_enabled,published_at,created_at,updated_at,metadata";
const CONTENT_FULL_FIELDS: string = `${CONTENT_SUMMARY_FIELDS},body_markdown`;
const COMMENT_FIELDS: string =
	"id,content_id,parent_id,author_name,author_website,body,status,created_at,updated_at";
const CONTENT_LIST_BATCH_SIZE = 1000;
const CONTENT_LIST_SCAN_LIMIT = 10_000;

const ACTION_ALIASES: Record<string, CanonicalAction> = {
	health: "health",
	health_check: "health",
	summary: "summary",
	metrics: "summary",
	get_post: "summary",
	view: "view",
	record_view: "view",
	like: "like",
	toggle_like: "like",
	share: "share",
	record_share: "share",
	comment: "comment",
	submit_comment: "comment",
	comments: "comments",
	"content-list": "content-list",
	content_list: "content-list",
	"content-get": "content-get",
	content_get: "content-get",
};

const SHARE_CHANNELS = new Set([
	"native",
	"web-share",
	"copy",
	"copy-link",
	"clipboard",
	"link",
	"poster",
	"qq",
	"wechat",
	"weibo",
	"x",
	"facebook",
	"other",
]);

const RATE_LIMITS: Record<
	"view" | "like" | "share" | "comment",
	{
		limit: number;
		windowSeconds: number;
	}
> = {
	view: { limit: 60, windowSeconds: 60 },
	like: { limit: 20, windowSeconds: 60 },
	share: { limit: 20, windowSeconds: 60 },
	comment: { limit: 3, windowSeconds: 600 },
};

class ApiError extends Error {
	status: number;
	code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

let cachedClient: SupabaseClient | null = null;
let cachedHmacKey: Promise<CryptoKey> | null = null;

function parseSecretKeyMap(raw: string | undefined): string | null {
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (typeof parsed.default === "string" && parsed.default.length > 0) {
			return parsed.default;
		}

		for (const value of Object.values(parsed)) {
			if (typeof value === "string" && value.length > 0) return value;
		}
	} catch {
		return null;
	}

	return null;
}

function getServerKey(): string {
	const key =
		Deno.env.get("SUPABASE_SECRET_KEY") ??
		parseSecretKeyMap(Deno.env.get("SUPABASE_SECRET_KEYS")) ??
		Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

	if (!key) {
		throw new ApiError(
			503,
			"SERVER_NOT_CONFIGURED",
			"Blog service is not configured.",
		);
	}

	return key;
}

function getSupabase(): SupabaseClient {
	if (cachedClient) return cachedClient;

	const url = Deno.env.get("SUPABASE_URL");
	if (!url) {
		throw new ApiError(
			503,
			"SERVER_NOT_CONFIGURED",
			"Blog service is not configured.",
		);
	}

	cachedClient = createClient(url, getServerKey(), {
		auth: {
			autoRefreshToken: false,
			detectSessionInUrl: false,
			persistSession: false,
		},
	});
	return cachedClient;
}

function normalizeOrigin(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

function getAllowedOrigins(): Set<string> {
	const configured = Deno.env.get("ALLOWED_ORIGINS");
	const source = configured?.trim()
		? configured.split(",")
		: [
				"https://f389722475.github.io",
				"http://localhost:4321",
				"http://127.0.0.1:4321",
			];

	return new Set(
		source
			.map((origin) => normalizeOrigin(origin.trim()))
			.filter((origin): origin is string => origin !== null),
	);
}

function requireAllowedOrigin(request: Request): string | null {
	const rawOrigin = request.headers.get("origin");
	if (!rawOrigin) {
		if (Deno.env.get("ALLOW_NO_ORIGIN") === "true") return null;
		throw new ApiError(
			403,
			"ORIGIN_REQUIRED",
			"Request origin is required.",
		);
	}

	const origin = normalizeOrigin(rawOrigin);
	if (!origin || !getAllowedOrigins().has(origin)) {
		throw new ApiError(
			403,
			"ORIGIN_NOT_ALLOWED",
			"Request origin is not allowed.",
		);
	}

	return origin;
}

function responseHeaders(origin: string | null): Headers {
	const headers = new Headers({
		"Access-Control-Allow-Headers":
			"authorization, apikey, content-type, x-client-info",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Max-Age": "86400",
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
		Vary: "Origin",
	});
	if (origin) headers.set("Access-Control-Allow-Origin", origin);
	return headers;
}

function jsonResponse(
	origin: string | null,
	status: number,
	payload: JsonObject,
): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: responseHeaders(origin),
	});
}

function ok(origin: string | null, data: JsonObject, status = 200): Response {
	return jsonResponse(origin, status, { ok: true, data });
}

function errorResponse(origin: string | null, error: ApiError): Response {
	return jsonResponse(origin, error.status, {
		ok: false,
		error: { code: error.code, message: error.message },
	});
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstValue(body: JsonObject, ...keys: string[]): unknown {
	for (const key of keys) {
		if (body[key] !== undefined) return body[key];
	}
	return undefined;
}

function optionalString(
	value: unknown,
	field: string,
	maxLength: number,
): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") {
		throw new ApiError(400, "INVALID_FIELD", `${field} must be a string.`);
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength) {
		throw new ApiError(
			400,
			"INVALID_FIELD",
			`${field} has an invalid length.`,
		);
	}
	return trimmed;
}

function requiredString(
	value: unknown,
	field: string,
	maxLength: number,
): string {
	const result = optionalString(value, field, maxLength);
	if (!result) {
		throw new ApiError(400, "MISSING_FIELD", `${field} is required.`);
	}
	return result;
}

function boundedInteger(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new ApiError(
			400,
			"INVALID_FIELD",
			"Pagination value is invalid.",
		);
	}
	return Math.min(maximum, Math.max(minimum, value));
}

function requireVisitorId(body: JsonObject): string {
	const visitorId = requiredString(
		firstValue(body, "visitorId", "visitor_id"),
		"visitorId",
		64,
	).toLowerCase();
	if (!UUID_PATTERN.test(visitorId)) {
		throw new ApiError(400, "INVALID_VISITOR", "visitorId must be a UUID.");
	}
	return visitorId;
}

function normalizeCanonicalPath(value: string): string {
	let path = value.trim().split(/[?#]/, 1)[0] ?? "";
	if (!path.startsWith("/")) path = `/${path}`;
	path = path.replace(/\/{2,}/g, "/");
	if (path.length > 1) path = path.replace(/\/+$/, "");
	if (path.length > 500 || /\s/.test(path)) {
		throw new ApiError(400, "INVALID_POST_KEY", "Post path is invalid.");
	}
	return path;
}

function requirePostKey(body: JsonObject): string {
	const postKey = requiredString(
		firstValue(
			body,
			"postKey",
			"post_key",
			"contentId",
			"content_id",
			"contentPath",
			"canonicalPath",
			"path",
		),
		"postKey",
		500,
	);
	return postKey.startsWith("/") ? normalizeCanonicalPath(postKey) : postKey;
}

async function parseBody(request: Request): Promise<JsonObject> {
	const type = request.headers.get("content-type")?.toLowerCase() ?? "";
	if (!type.includes("application/json")) {
		throw new ApiError(415, "JSON_REQUIRED", "Content-Type must be JSON.");
	}

	const declaredLength = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
		throw new ApiError(413, "BODY_TOO_LARGE", "Request body is too large.");
	}

	const raw = await request.text();
	if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
		throw new ApiError(413, "BODY_TOO_LARGE", "Request body is too large.");
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isObject(parsed)) throw new Error("not an object");
		return parsed;
	} catch {
		throw new ApiError(
			400,
			"INVALID_JSON",
			"Request body is invalid JSON.",
		);
	}
}

function normalizeAction(value: unknown): CanonicalAction {
	if (typeof value !== "string") {
		throw new ApiError(400, "MISSING_ACTION", "action is required.");
	}
	const action = ACTION_ALIASES[value.trim().toLowerCase()];
	if (!action) {
		throw new ApiError(400, "UNKNOWN_ACTION", "Unsupported blog action.");
	}
	return action;
}

async function getHmacKey(): Promise<CryptoKey> {
	if (cachedHmacKey) return cachedHmacKey;
	const secret = Deno.env.get("VISITOR_HASH_SECRET") ?? getServerKey();
	cachedHmacKey = crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return cachedHmacKey;
}

async function hmac(value: string): Promise<string> {
	const signature = await crypto.subtle.sign(
		"HMAC",
		await getHmacKey(),
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function temporaryClientIp(request: Request): string {
	const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0];
	return (forwarded ?? "unknown").trim();
}

async function visitorHash(visitorId: string): Promise<string> {
	return await hmac(`visitor\n${visitorId}`);
}

async function enforceRateLimit(
	request: Request,
	action: "view" | "like" | "share" | "comment",
	hashedVisitor: string,
): Promise<void> {
	const rule = RATE_LIMITS[action];
	const ipHash = await hmac(`ip\n${temporaryClientIp(request)}`);
	const [ipBucketKey, visitorBucketKey] = await Promise.all([
		hmac(`rate\nip\n${action}\n${ipHash}`),
		hmac(`rate\nvisitor\n${action}\n${hashedVisitor}`),
	]);
	const client = getSupabase();
	const [ipResult, visitorResult] = await Promise.all([
		client.rpc("blog_check_rate_limit", {
			p_action: `${action}:ip`,
			p_bucket_key: ipBucketKey,
			p_limit: rule.limit,
			p_window_seconds: rule.windowSeconds,
		}),
		client.rpc("blog_check_rate_limit", {
			p_action: `${action}:visitor`,
			p_bucket_key: visitorBucketKey,
			p_limit: rule.limit,
			p_window_seconds: rule.windowSeconds,
		}),
	]);

	if (ipResult.data === false || visitorResult.data === false) {
		throw new ApiError(
			429,
			"RATE_LIMITED",
			"Too many requests. Try again later.",
		);
	}

	if (ipResult.error) {
		console.warn(
			`[blog-api] IP rate limiter unavailable (${ipResult.error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"RATE_LIMIT_UNAVAILABLE",
			"Request validation is temporarily unavailable.",
		);
	}

	if (visitorResult.error) {
		console.warn(
			`[blog-api] visitor rate limiter unavailable (${visitorResult.error.code ?? "unknown"})`,
		);
		if (action === "comment") {
			throw new ApiError(
				503,
				"RATE_LIMIT_UNAVAILABLE",
				"Comment validation is temporarily unavailable.",
			);
		}
		// For low-impact counters, the independently enforced IP bucket still
		// prevents rotating a client-controlled visitor UUID to bypass limits.
	}
}

async function verifyTurnstile(body: JsonObject): Promise<void> {
	const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
	if (!secret) return;

	const token = requiredString(
		firstValue(body, "turnstileToken", "turnstile_token"),
		"turnstileToken",
		4096,
	);
	const form = new FormData();
	form.set("secret", secret);
	form.set("response", token);

	try {
		const response = await fetch(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{ method: "POST", body: form },
		);
		const result = (await response.json()) as { success?: boolean };
		if (!response.ok || result.success !== true) {
			throw new ApiError(
				400,
				"CAPTCHA_FAILED",
				"Human verification failed.",
			);
		}
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(
			503,
			"CAPTCHA_UNAVAILABLE",
			"Human verification is unavailable.",
		);
	}
}

async function resolvePublishedContent(
	postKey: string,
	includeBody = false,
): Promise<ContentRow> {
	const client = getSupabase();
	let query = client
		.from("content_entries")
		.select(includeBody ? CONTENT_FULL_FIELDS : CONTENT_SUMMARY_FIELDS)
		.eq("status", "published")
		.lte("published_at", new Date().toISOString());

	if (UUID_PATTERN.test(postKey)) {
		query = query.eq("id", postKey);
	} else if (postKey.startsWith("/")) {
		query = query.eq("canonical_path", normalizeCanonicalPath(postKey));
	} else {
		query = query.eq("post_key", postKey);
	}

	const { data, error } = await query.limit(1).maybeSingle();
	if (error) {
		console.warn(
			`[blog-api] content lookup failed (${error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Content is temporarily unavailable.",
		);
	}
	if (!data) {
		throw new ApiError(
			404,
			"CONTENT_NOT_FOUND",
			"Published content was not found.",
		);
	}
	const content = data as unknown as ContentRow;
	if (content.metadata?.trashed === true) {
		throw new ApiError(
			404,
			"CONTENT_NOT_FOUND",
			"Published content was not found.",
		);
	}
	return content;
}

function numericCount(value: number | string | null | undefined): number {
	const parsed = Number(value ?? 0);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function metrics(row?: MetricRow | null): JsonObject {
	const views = numericCount(row?.view_count);
	const likes = numericCount(row?.like_count);
	const shares = numericCount(row?.share_count);
	const comments = numericCount(row?.comment_count);
	return {
		views,
		likes,
		shares,
		comments,
		view_count: views,
		like_count: likes,
		share_count: shares,
		comment_count: comments,
	};
}

async function getMetrics(contentId: string): Promise<JsonObject> {
	const { data, error } = await getSupabase()
		.from("content_stats")
		.select("view_count,like_count,share_count,comment_count")
		.eq("content_id", contentId)
		.limit(1)
		.maybeSingle();
	if (error) {
		console.warn(
			`[blog-api] metrics lookup failed (${error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Metrics are temporarily unavailable.",
		);
	}
	return metrics(data as MetricRow | null);
}

async function getLiked(
	contentId: string,
	hashedVisitor: string,
): Promise<boolean> {
	const { data, error } = await getSupabase()
		.from("content_likes")
		.select("content_id")
		.eq("content_id", contentId)
		.eq("visitor_hash", hashedVisitor)
		.limit(1)
		.maybeSingle();
	if (error) {
		console.warn(
			`[blog-api] like lookup failed (${error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Likes are temporarily unavailable.",
		);
	}
	return data !== null;
}

function publicComment(row: CommentRow): JsonObject {
	return {
		id: row.id,
		contentId: row.content_id,
		content_id: row.content_id,
		parentId: row.parent_id,
		parent_id: row.parent_id,
		authorName: row.author_name,
		author_name: row.author_name,
		authorWebsite: row.author_website,
		author_website: row.author_website,
		content: row.body,
		body: row.body,
		status: row.status,
		createdAt: row.created_at,
		created_at: row.created_at,
		updatedAt: row.updated_at,
		updated_at: row.updated_at,
	};
}

async function getApprovedComments(
	contentId: string,
	limit = 100,
): Promise<JsonObject[]> {
	const { data, error } = await getSupabase()
		.from("comments")
		.select(COMMENT_FIELDS)
		.eq("content_id", contentId)
		.eq("status", "approved")
		.order("created_at", { ascending: true })
		.limit(limit);
	if (error) {
		console.warn(
			`[blog-api] comments lookup failed (${error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Comments are temporarily unavailable.",
		);
	}
	return ((data ?? []) as unknown as CommentRow[]).map(publicComment);
}

function publicContent(row: ContentRow, includeBody = false): JsonObject {
	const pinned = row.metadata?.pinned === true;
	const priority =
		typeof row.metadata?.priority === "number" &&
		Number.isFinite(row.metadata.priority)
			? row.metadata.priority
			: null;
	const result: JsonObject = {
		id: row.id,
		postKey: row.post_key,
		post_key: row.post_key,
		kind: row.kind,
		canonicalPath: row.canonical_path,
		canonical_path: row.canonical_path,
		title: row.title,
		summary: row.summary,
		coverObjectPath: row.cover_object_path,
		cover_object_path: row.cover_object_path,
		tags: row.tags,
		category: row.category,
		pinned,
		priority,
		commentEnabled: row.comment_enabled,
		comment_enabled: row.comment_enabled,
		publishedAt: row.published_at,
		published_at: row.published_at,
		createdAt: row.created_at,
		created_at: row.created_at,
		updatedAt: row.updated_at,
		updated_at: row.updated_at,
	};
	if (includeBody) {
		result.bodyMarkdown = row.body_markdown ?? "";
		result.body_markdown = row.body_markdown ?? "";
		result.metadata = row.metadata ?? {};
	}
	return result;
}

function comparePublicContent(left: ContentRow, right: ContentRow): number {
	const leftPinned = left.metadata?.pinned === true;
	const rightPinned = right.metadata?.pinned === true;
	if (leftPinned !== rightPinned) {
		return leftPinned ? -1 : 1;
	}

	if (leftPinned && rightPinned) {
		const leftPriority =
			typeof left.metadata?.priority === "number" &&
			Number.isFinite(left.metadata.priority)
				? left.metadata.priority
				: null;
		const rightPriority =
			typeof right.metadata?.priority === "number" &&
			Number.isFinite(right.metadata.priority)
				? right.metadata.priority
				: null;
		if (leftPriority !== rightPriority) {
			if (leftPriority === null) return 1;
			if (rightPriority === null) return -1;
			return leftPriority - rightPriority;
		}
	}

	const publishedDifference =
		new Date(right.published_at).getTime() -
		new Date(left.published_at).getTime();
	return (
		publishedDifference || left.post_key.localeCompare(right.post_key, "en")
	);
}

function firstRpcRow(data: unknown): JsonObject {
	if (Array.isArray(data) && isObject(data[0])) return data[0];
	if (isObject(data)) return data;
	throw new ApiError(
		503,
		"DATABASE_UNAVAILABLE",
		"Metrics are temporarily unavailable.",
	);
}

async function summaryAction(body: JsonObject): Promise<JsonObject> {
	const content = await resolvePublishedContent(requirePostKey(body));
	const suppliedVisitor = firstValue(body, "visitorId", "visitor_id");
	let liked = false;
	if (
		suppliedVisitor !== undefined &&
		suppliedVisitor !== null &&
		suppliedVisitor !== ""
	) {
		const hashedVisitor = await visitorHash(requireVisitorId(body));
		liked = await getLiked(content.id, hashedVisitor);
	}

	return {
		content: publicContent(content),
		metrics: await getMetrics(content.id),
		liked,
		comments: content.comment_enabled
			? await getApprovedComments(content.id)
			: [],
	};
}

async function healthAction(): Promise<JsonObject> {
	// This intentionally performs a real, read-only PostgreSQL request through
	// the same service client used by the public interaction actions.  Returning
	// only a fixed status proves the Edge dispatch and database dependency are
	// available without exposing row contents, counts, configuration, or timing.
	const { error } = await getSupabase()
		.from("content_entries")
		.select("id")
		.limit(1);
	if (error) {
		console.warn(
			`[blog-api] health query failed (${error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Blog service is temporarily unavailable.",
		);
	}
	return { status: "ok", database: "reachable" };
}

async function commentsAction(body: JsonObject): Promise<JsonObject> {
	const content = await resolvePublishedContent(requirePostKey(body));
	const limit = boundedInteger(firstValue(body, "limit"), 100, 1, 100);
	return {
		content: publicContent(content),
		metrics: await getMetrics(content.id),
		comments: content.comment_enabled
			? await getApprovedComments(content.id, limit)
			: [],
	};
}

async function viewAction(
	request: Request,
	body: JsonObject,
): Promise<JsonObject> {
	const content = await resolvePublishedContent(requirePostKey(body));
	const visitorId = requireVisitorId(body);
	const hashedVisitor = await visitorHash(visitorId);
	await enforceRateLimit(request, "view", hashedVisitor);

	const sessionId = optionalString(
		firstValue(body, "sessionId", "session_id"),
		"sessionId",
		128,
	);
	if (sessionId && !SAFE_TOKEN_PATTERN.test(sessionId)) {
		throw new ApiError(400, "INVALID_FIELD", "sessionId is invalid.");
	}
	const bucket = sessionId ?? new Date().toISOString().slice(0, 10);
	const eventKey = await hmac(
		`event\nview\n${content.id}\n${hashedVisitor}\n${bucket}`,
	);

	const { data, error } = await getSupabase().rpc("blog_record_event", {
		p_channel: null,
		p_content_id: content.id,
		p_event_key: eventKey,
		p_event_type: "view",
		p_visitor_hash: hashedVisitor,
	});
	if (error) {
		console.warn(
			`[blog-api] view write failed (${error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"View could not be recorded.",
		);
	}
	const row = firstRpcRow(data);
	return {
		content: publicContent(content),
		metrics: metrics(row as MetricRow),
		liked: await getLiked(content.id, hashedVisitor),
		recorded: row.recorded === true,
	};
}

async function likeAction(
	request: Request,
	body: JsonObject,
): Promise<JsonObject> {
	const content = await resolvePublishedContent(requirePostKey(body));
	const hashedVisitor = await visitorHash(requireVisitorId(body));
	await enforceRateLimit(request, "like", hashedVisitor);

	const { data, error } = await getSupabase().rpc("blog_toggle_like", {
		p_content_id: content.id,
		p_visitor_hash: hashedVisitor,
	});
	if (error) {
		console.warn(
			`[blog-api] like toggle failed (${error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Like could not be updated.",
		);
	}
	const row = firstRpcRow(data);
	return {
		content: publicContent(content),
		metrics: metrics(row as MetricRow),
		liked: row.liked === true,
	};
}

async function shareAction(
	request: Request,
	body: JsonObject,
): Promise<JsonObject> {
	const content = await resolvePublishedContent(requirePostKey(body));
	const hashedVisitor = await visitorHash(requireVisitorId(body));
	await enforceRateLimit(request, "share", hashedVisitor);

	const channel = requiredString(
		firstValue(body, "method", "channel"),
		"method",
		40,
	).toLowerCase();
	if (!SHARE_CHANNELS.has(channel)) {
		throw new ApiError(
			400,
			"INVALID_SHARE_METHOD",
			"Share method is invalid.",
		);
	}
	const fiveMinuteBucket = Math.floor(Date.now() / 300_000).toString();
	const eventKey = await hmac(
		`event\nshare\n${content.id}\n${hashedVisitor}\n${channel}\n${fiveMinuteBucket}`,
	);

	const { data, error } = await getSupabase().rpc("blog_record_event", {
		p_channel: channel,
		p_content_id: content.id,
		p_event_key: eventKey,
		p_event_type: "share",
		p_visitor_hash: hashedVisitor,
	});
	if (error) {
		console.warn(
			`[blog-api] share write failed (${error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Share could not be recorded.",
		);
	}
	const row = firstRpcRow(data);
	return {
		content: publicContent(content),
		metrics: metrics(row as MetricRow),
		liked: await getLiked(content.id, hashedVisitor),
		recorded: row.recorded === true,
	};
}

function validWebsite(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:")
			throw new Error();
		return url.toString();
	} catch {
		throw new ApiError(400, "INVALID_WEBSITE", "authorWebsite is invalid.");
	}
}

async function commentAction(
	request: Request,
	body: JsonObject,
): Promise<JsonObject> {
	const content = await resolvePublishedContent(requirePostKey(body));
	if (!content.comment_enabled) {
		throw new ApiError(
			403,
			"COMMENTS_DISABLED",
			"Comments are disabled for this content.",
		);
	}
	if (optionalString(firstValue(body, "honeypot"), "honeypot", 200)) {
		throw new ApiError(
			400,
			"INVALID_SUBMISSION",
			"Comment submission is invalid.",
		);
	}

	const hashedVisitor = await visitorHash(requireVisitorId(body));
	await enforceRateLimit(request, "comment", hashedVisitor);
	await verifyTurnstile(body);

	const authorName = requiredString(
		firstValue(body, "authorName", "author_name"),
		"authorName",
		60,
	);
	const commentBody = requiredString(
		firstValue(body, "content", "body"),
		"content",
		2000,
	);
	const authorWebsite = validWebsite(
		optionalString(
			firstValue(body, "authorWebsite", "author_website"),
			"authorWebsite",
			500,
		),
	);
	const parentId = optionalString(
		firstValue(body, "parentId", "parent_id"),
		"parentId",
		64,
	);
	if (parentId && !UUID_PATTERN.test(parentId)) {
		throw new ApiError(400, "INVALID_PARENT", "parentId must be a UUID.");
	}

	if (parentId) {
		const { data: parent, error: parentError } = await getSupabase()
			.from("comments")
			.select("id")
			.eq("id", parentId)
			.eq("content_id", content.id)
			.eq("status", "approved")
			.limit(1)
			.maybeSingle();
		if (parentError) {
			console.warn(
				`[blog-api] parent lookup failed (${parentError.code ?? "unknown"})`,
			);
			throw new ApiError(
				503,
				"DATABASE_UNAVAILABLE",
				"Comment could not be submitted.",
			);
		}
		if (!parent) {
			throw new ApiError(
				400,
				"INVALID_PARENT",
				"Reply target was not found.",
			);
		}
	}

	const { data, error } = await getSupabase()
		.from("comments")
		.insert({
			author_name: authorName,
			author_website: authorWebsite,
			body: commentBody,
			content_id: content.id,
			parent_id: parentId,
			status: "pending",
			visitor_hash: hashedVisitor,
		})
		.select(COMMENT_FIELDS)
		.single();
	if (error || !data) {
		console.warn(
			`[blog-api] comment write failed (${error?.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Comment could not be submitted.",
		);
	}

	return {
		content: publicContent(content),
		metrics: await getMetrics(content.id),
		liked: await getLiked(content.id, hashedVisitor),
		comment: publicComment(data as unknown as CommentRow),
	};
}

async function contentListAction(body: JsonObject): Promise<JsonObject> {
	const limit = boundedInteger(firstValue(body, "limit"), 20, 1, 50);
	const offset = boundedInteger(firstValue(body, "offset"), 0, 0, 5000);
	const kind = optionalString(firstValue(body, "kind"), "kind", 20);
	if (kind && kind !== "article" && kind !== "diary") {
		throw new ApiError(
			400,
			"INVALID_KIND",
			"kind must be article or diary.",
		);
	}

	const rows: ContentRow[] = [];
	const now = new Date().toISOString();
	for (
		let start = 0;
		start < CONTENT_LIST_SCAN_LIMIT;
		start += CONTENT_LIST_BATCH_SIZE
	) {
		const end = Math.min(
			start + CONTENT_LIST_BATCH_SIZE - 1,
			CONTENT_LIST_SCAN_LIMIT - 1,
		);
		let query = getSupabase()
			.from("content_entries")
			.select(CONTENT_SUMMARY_FIELDS)
			.eq("status", "published")
			.lte("published_at", now)
			.order("published_at", { ascending: false })
			.range(start, end);
		if (kind) query = query.eq("kind", kind);

		const { data, error } = await query;
		if (error) {
			console.warn(
				`[blog-api] content list failed (${error.code ?? "unknown"})`,
			);
			throw new ApiError(
				503,
				"DATABASE_UNAVAILABLE",
				"Content is temporarily unavailable.",
			);
		}
		const batch = (data ?? []) as unknown as ContentRow[];
		rows.push(...batch);
		if (batch.length < end - start + 1) {
			break;
		}
	}
	if (rows.length >= CONTENT_LIST_SCAN_LIMIT) {
		console.warn("[blog-api] public content scan limit reached");
		throw new ApiError(
			503,
			"CONTENT_LIST_LIMIT_REACHED",
			"Content is temporarily unavailable.",
		);
	}

	const visibleRows = rows
		.filter(
			(item) =>
				item.metadata?.hidden !== true &&
				item.metadata?.trashed !== true,
		)
		.sort(comparePublicContent);
	return {
		items: visibleRows
			.slice(offset, offset + limit)
			.map((item) => publicContent(item)),
		pagination: { limit, offset, total: visibleRows.length },
	};
}

async function contentGetAction(body: JsonObject): Promise<JsonObject> {
	const content = await resolvePublishedContent(requirePostKey(body), true);
	const suppliedVisitor = firstValue(body, "visitorId", "visitor_id");
	let liked = false;
	if (
		suppliedVisitor !== undefined &&
		suppliedVisitor !== null &&
		suppliedVisitor !== ""
	) {
		liked = await getLiked(
			content.id,
			await visitorHash(requireVisitorId(body)),
		);
	}
	return {
		content: publicContent(content, true),
		metrics: await getMetrics(content.id),
		liked,
		comments: content.comment_enabled
			? await getApprovedComments(content.id)
			: [],
	};
}

async function dispatch(
	request: Request,
	body: JsonObject,
): Promise<{ data: JsonObject; status?: number }> {
	const action = normalizeAction(body.action);
	switch (action) {
		case "health":
			return { data: await healthAction() };
		case "summary":
			return { data: await summaryAction(body) };
		case "comments":
			return { data: await commentsAction(body) };
		case "view":
			return { data: await viewAction(request, body) };
		case "like":
			return { data: await likeAction(request, body) };
		case "share":
			return { data: await shareAction(request, body) };
		case "comment":
			return { data: await commentAction(request, body), status: 202 };
		case "content-list":
			return { data: await contentListAction(body) };
		case "content-get":
			return { data: await contentGetAction(body) };
	}

	throw new ApiError(400, "UNKNOWN_ACTION", "Unsupported blog action.");
}

Deno.serve(async (request: Request) => {
	let origin: string | null = null;
	try {
		origin = requireAllowedOrigin(request);
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: responseHeaders(origin),
			});
		}
		if (request.method !== "POST") {
			throw new ApiError(
				405,
				"METHOD_NOT_ALLOWED",
				"Use POST for blog actions.",
			);
		}

		const body = await parseBody(request);
		const result = await dispatch(request, body);
		return ok(origin, result.data, result.status ?? 200);
	} catch (error) {
		if (error instanceof ApiError) return errorResponse(origin, error);
		console.error("[blog-api] unexpected internal error");
		return errorResponse(
			origin,
			new ApiError(
				500,
				"INTERNAL_ERROR",
				"An unexpected error occurred.",
			),
		);
	}
});
