const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL?.trim().replace(
	/\/+$/,
	"",
);
const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

const blogApiUrl = supabaseUrl ? `${supabaseUrl}/functions/v1/blog-api` : "";
const REQUEST_TIMEOUT_MS = 12_000;

export const isBlogApiConfigured = Boolean(blogApiUrl && publishableKey);

export type ShareMethod = "web-share" | "copy-link";

export interface BlogMetrics {
	views: number;
	likes: number;
	shares: number;
}

export interface BlogComment {
	id: string;
	authorName: string;
	content: string;
	createdAt: string;
	status: "approved";
}

export interface BlogSnapshot {
	metrics: BlogMetrics;
	liked: boolean;
	comments: BlogComment[];
}

export interface BlogMutationResult {
	metrics?: BlogMetrics;
	liked?: boolean;
	comment?: BlogComment;
}

type JsonRecord = Record<string, unknown>;

export class BlogApiError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "BlogApiError";
		this.status = status;
	}
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

function readString(source: JsonRecord, keys: string[]): string {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string") {
			return value;
		}
	}
	return "";
}

function readBoolean(source: JsonRecord, keys: string[]): boolean | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "boolean") {
			return value;
		}
	}
	return undefined;
}

function readCount(source: JsonRecord, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return Math.max(0, Math.trunc(value));
		}
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return Math.max(0, Math.trunc(parsed));
			}
		}
	}
	return undefined;
}

function normalizeMetrics(
	source: JsonRecord,
	fallback?: BlogMetrics,
): BlogMetrics | undefined {
	const metrics = asRecord(source.metrics);
	const counts = asRecord(source.counts);
	const candidates =
		Object.keys(metrics).length > 0
			? metrics
			: Object.keys(counts).length > 0
				? counts
				: source;

	const views = readCount(candidates, ["views", "viewCount", "view_count"]);
	const likes = readCount(candidates, ["likes", "likeCount", "like_count"]);
	const shares = readCount(candidates, [
		"shares",
		"shareCount",
		"share_count",
	]);

	if (
		views === undefined &&
		likes === undefined &&
		shares === undefined &&
		!fallback
	) {
		return undefined;
	}

	return {
		views: views ?? fallback?.views ?? 0,
		likes: likes ?? fallback?.likes ?? 0,
		shares: shares ?? fallback?.shares ?? 0,
	};
}

function normalizeComment(value: unknown): BlogComment | null {
	const source = asRecord(value);
	const id = readString(source, ["id", "commentId", "comment_id"]);
	const content = readString(source, ["content", "body", "message"]);
	const status = readString(source, ["status"]);

	if (!id || !content || (status && status !== "approved")) {
		return null;
	}

	return {
		id,
		authorName:
			readString(source, [
				"authorName",
				"author_name",
				"nickname",
				"name",
			]) || "匿名访客",
		content,
		createdAt: readString(source, [
			"createdAt",
			"created_at",
			"publishedAt",
			"published_at",
		]),
		status: "approved",
	};
}

function normalizeComments(value: unknown): BlogComment[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map(normalizeComment)
		.filter((comment): comment is BlogComment => comment !== null);
}

function normalizeMutation(source: JsonRecord): BlogMutationResult {
	const comment = normalizeComment(source.comment);
	return {
		metrics: normalizeMetrics(source),
		liked: readBoolean(source, ["liked", "hasLiked", "has_liked"]),
		comment: comment ?? undefined,
	};
}

async function request(
	action: string,
	payload: JsonRecord,
	signal?: AbortSignal,
): Promise<JsonRecord> {
	if (!isBlogApiConfigured || !publishableKey) {
		throw new BlogApiError("互动服务尚未配置");
	}

	const controller = new AbortController();
	const forwardAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) {
		forwardAbort();
	} else {
		signal?.addEventListener("abort", forwardAbort, { once: true });
	}
	const timeout = window.setTimeout(
		() =>
			controller.abort(
				new DOMException("Request timed out", "TimeoutError"),
			),
		REQUEST_TIMEOUT_MS,
	);

	try {
		const response = await fetch(blogApiUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				apikey: publishableKey,
			},
			body: JSON.stringify({ action, ...payload }),
			signal: controller.signal,
		});

		let body: unknown = {};
		try {
			body = await response.json();
		} catch {
			// A non-JSON error response is normalized below without exposing it.
		}

		const envelope = asRecord(body);
		if (!response.ok || envelope.ok === false) {
			const message = readString(envelope, ["message", "error"]);
			throw new BlogApiError(
				message || "互动服务暂时不可用",
				response.status,
			);
		}

		return Object.prototype.hasOwnProperty.call(envelope, "data")
			? asRecord(envelope.data)
			: envelope;
	} finally {
		window.clearTimeout(timeout);
		signal?.removeEventListener("abort", forwardAbort);
	}
}

export async function getPostSnapshot(
	postKey: string,
	visitorId: string,
	signal?: AbortSignal,
): Promise<BlogSnapshot> {
	const data = await request("get_post", { postKey, visitorId }, signal);
	return {
		metrics: normalizeMetrics(data, { views: 0, likes: 0, shares: 0 })!,
		liked: readBoolean(data, ["liked", "hasLiked", "has_liked"]) ?? false,
		comments: normalizeComments(data.comments),
	};
}

export async function recordPostView(
	input: {
		postKey: string;
		visitorId: string;
		sessionId: string;
		path: string;
		title: string;
	},
	signal?: AbortSignal,
): Promise<BlogMutationResult> {
	return normalizeMutation(await request("record_view", input, signal));
}

export async function togglePostLike(
	input: { postKey: string; visitorId: string },
	signal?: AbortSignal,
): Promise<BlogMutationResult> {
	return normalizeMutation(await request("toggle_like", input, signal));
}

export async function recordPostShare(
	input: {
		postKey: string;
		visitorId: string;
		method: ShareMethod;
		path: string;
	},
	signal?: AbortSignal,
): Promise<BlogMutationResult> {
	return normalizeMutation(await request("record_share", input, signal));
}

export async function submitPostComment(
	input: {
		postKey: string;
		visitorId: string;
		authorName: string;
		content: string;
	},
	signal?: AbortSignal,
): Promise<BlogMutationResult> {
	return normalizeMutation(await request("submit_comment", input, signal));
}
