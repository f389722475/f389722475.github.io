const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL?.trim().replace(
	/\/+$/,
	"",
);
const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
const adminApiUrl = supabaseUrl
	? `${supabaseUrl}/functions/v1/blog-admin-api`
	: "";
const REQUEST_TIMEOUT_MS = 60_000;

export const isAdminApiConfigured = Boolean(adminApiUrl && publishableKey);

export type AdminCommentStatus =
	"pending" | "approved" | "rejected" | "spam" | "all";
export type AdminCommentFilter = AdminCommentStatus;
export type AdminStoredCommentStatus = Exclude<AdminCommentStatus, "all">;
export type AdminCommentDecision = "approve" | "reject" | "spam" | "delete";
export type AdminServiceStatus =
	"up" | "healthy" | "degraded" | "down" | "unknown";

export interface AdminMe {
	isAdmin: boolean;
	user: {
		id: string;
		githubId: string;
		login: string | null;
		avatarUrl: string | null;
	};
}

export interface AdminCommentCounts {
	pending: number;
	approved: number;
	rejected: number;
	spam: number;
	all: number;
}

export interface AdminComment {
	id: string;
	contentId: string;
	parentId: string | null;
	post: {
		title: string;
		canonicalPath: string;
	};
	authorName: string;
	authorWebsite: string | null;
	body: string;
	status: AdminStoredCommentStatus;
	createdAt: string;
	updatedAt: string;
	moderatedAt: string | null;
	moderationNote: string | null;
}

export interface AdminPagination {
	limit: number;
	offset: number;
	total: number;
}

export interface AdminCommentsResult {
	items: AdminComment[];
	pagination: AdminPagination;
	counts: AdminCommentCounts;
}

export interface AdminModerateCommentInput {
	commentId: string;
	decision: AdminCommentDecision;
	note?: string;
}

export interface AdminModerateCommentResult {
	commentId: string;
	decision: AdminCommentDecision;
	status: AdminStoredCommentStatus | null;
	deleted: boolean;
	moderatedAt: string;
	counts: AdminCommentCounts;
}

export interface AdminAuditEntry {
	id: string | number;
	actorProviderId: string;
	action: string;
	targetType: string;
	targetId: string;
	oldStatus: string | null;
	newStatus: string | null;
	details: Record<string, unknown>;
	createdAt: string;
}

export interface AdminAuditLogResult {
	items: AdminAuditEntry[];
	pagination?: AdminPagination;
}

// Stable public names consumed by the admin UI components.
export type AdminCommentsResponse = AdminCommentsResult;
export type AdminAuditItem = AdminAuditEntry;
export type AdminAuditResponse = AdminAuditLogResult;
export type AdminModerationDecision = AdminCommentDecision;

export type AdminContentPostStatus =
	"published" | "draft" | "scheduled" | "trash";
export type AdminContentPostKind = "article" | "diary";

export interface AdminContentPost {
	id: string;
	sha?: string;
	trashPath?: string;
	trashedAt?: string;
	title: string;
	slug: string;
	description: string;
	body: string;
	image: string;
	tags: string[];
	category: string;
	kind: AdminContentPostKind;
	status: AdminContentPostStatus;
	hidden: boolean;
	pinned: boolean;
	priority: number | null;
	comment: boolean;
	encrypted: boolean;
	password: string;
	passwordHint: string;
	publishedAt: string;
	updatedAt: string;
	author: string;
	lang: string;
	alias: string;
	permalink: string;
	sourceLink: string;
	licenseName: string;
	licenseUrl: string;
}

export interface AdminContentRevision {
	headSha: string;
	branch: string;
	repository: string;
}

export interface AdminContentListResult {
	posts: AdminContentPost[];
	revision: AdminContentRevision;
	limits: {
		maxOperations: number;
	};
}

export type AdminContentCommitOperation =
	| {
			op: "save";
			post: AdminContentPost;
			expectedSha?: string;
	  }
	| {
			op: "trash";
			id: string;
			expectedSha?: string;
	  }
	| {
			op: "restore";
			id: string;
			expectedSha?: string;
			slug?: string;
	  }
	| {
			op: "delete";
			id: string;
			expectedSha?: string;
			confirm: true;
	  }
	| {
			op: "taxonomy";
			taxonomy: "category" | "tag";
			mode: "rename" | "merge" | "delete";
			from: string;
			to?: string;
	  };

export interface AdminContentCommitInput {
	baseHeadSha: string;
	message?: string;
	operations: AdminContentCommitOperation[];
}

export interface AdminContentCommitResult {
	commit: {
		sha: string;
		url: string | null;
	} | null;
	posts: AdminContentPost[];
	revision: AdminContentRevision;
}

export interface AdminContentOverview {
	articles: number;
	diaries: number;
	published: number;
	drafts: number;
	views: number;
	likes: number;
	shares: number;
	comments: number;
}

export interface AdminCommentOverview {
	pending: number;
	approved: number;
	rejected: number;
	spam: number;
	oldestPendingAt: string | null;
}

export interface AdminByteUsage {
	totalBytes?: number | null;
	availableBytes?: number | null;
	usedBytes?: number | null;
	usedPercent?: number | null;
}

export interface AdminDatabaseOverview {
	sizeBytes?: number | null;
	connections?: number | null;
	maxConnections?: number | null;
	connectionPercent?: number | null;
	cacheHitPercent?: number | null;
	walBytes?: number | null;
	status?: AdminServiceStatus;
}

export interface AdminInfrastructureOverview {
	memory: AdminByteUsage;
	disk: AdminByteUsage & { mountpoint: string };
	database: AdminDatabaseOverview;
	load: {
		one?: number | null;
		five?: number | null;
		fifteen?: number | null;
	};
	cpu: {
		usedPercent: number | null;
		note?: string | null;
	};
	storage: {
		objects: number;
		sizeBytes: number;
	};
}

export interface AdminLatencyOverview {
	edgeMs: number | null;
	databaseMs: number | null;
	siteMs: number | null;
	blogApiMs: number | null;
}

export interface AdminServiceProbe {
	ok: boolean;
	status: AdminServiceStatus;
	httpStatus?: number | null;
	latencyMs: number | null;
}

export interface AdminProbeHistoryEntry {
	checkedAt: string;
	service: "site" | "blog-api" | "database";
	status: AdminServiceStatus;
	latencyMs: number | null;
	httpStatus: number | null;
}

export interface AdminMonitoringWindow {
	intervalMinutes: number;
	sampleCount: number;
	expectedSamples: number;
	coveragePercent: number;
	minCoveragePercent: number;
	lastMonitorAt: string | null;
	stale: boolean;
	ready: boolean;
}

interface AdminHealthSummary {
	services: {
		site: AdminServiceProbe;
		blogApi: AdminServiceProbe;
		database: AdminServiceProbe;
	};
	uptime24h: {
		site: number | null;
		blogApi: number | null;
		database: number | null;
	};
	p95Latency24h: {
		site: number | null;
		blogApi: number | null;
		database: number | null;
	};
	monitoring24h: AdminMonitoringWindow;
}

export interface AdminProbe extends AdminHealthSummary {
	sampledAt: string;
	status: AdminServiceStatus;
	infrastructure: AdminInfrastructureOverview;
	latency: AdminLatencyOverview;
	source: {
		metrics: string;
		metricsAvailable?: boolean;
		metricsLatencyMs?: number | null;
		refreshSeconds: number;
	};
}

export interface AdminOverview extends AdminProbe {
	content: AdminContentOverview;
	comments: AdminCommentOverview;
	history: AdminProbeHistoryEntry[];
}

type JsonObject = Record<string, unknown>;

export class AdminApiError extends Error {
	readonly status?: number;
	readonly code?: string;

	constructor(message: string, status?: number, code?: string) {
		super(message);
		this.name = "AdminApiError";
		this.status = status;
		this.code = code;
	}
}

function asObject(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

function readString(source: JsonObject, ...keys: string[]): string {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return "";
}

async function requestAdmin<T>(
	accessToken: string,
	action: string,
	payload: JsonObject = {},
	signal?: AbortSignal,
): Promise<T> {
	if (!isAdminApiConfigured || !publishableKey) {
		throw new AdminApiError("管理员服务尚未配置。", 503, "NOT_CONFIGURED");
	}

	const token = accessToken.trim();
	if (!token) {
		throw new AdminApiError("管理员登录已失效。", 401, "AUTH_REQUIRED");
	}

	const controller = new AbortController();
	const forwardAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) {
		forwardAbort();
	} else {
		signal?.addEventListener("abort", forwardAbort, { once: true });
	}
	const timeout = globalThis.setTimeout(
		() =>
			controller.abort(
				new DOMException("Request timed out", "TimeoutError"),
			),
		REQUEST_TIMEOUT_MS,
	);

	try {
		const response = await fetch(adminApiUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				apikey: publishableKey,
			},
			body: JSON.stringify({ action, ...payload }),
			signal: controller.signal,
		});

		let parsed: unknown = {};
		try {
			parsed = await response.json();
		} catch {
			// Non-JSON gateway errors are normalized below.
		}

		const envelope = asObject(parsed);
		if (!response.ok || envelope.ok === false) {
			const error = asObject(envelope.error);
			throw new AdminApiError(
				readString(error, "message") ||
					readString(envelope, "message") ||
					"管理员服务暂时不可用。",
				response.status,
				readString(error, "code") || readString(envelope, "code"),
			);
		}

		const data = Object.prototype.hasOwnProperty.call(envelope, "data")
			? envelope.data
			: envelope;
		return data as T;
	} catch (error) {
		if (error instanceof AdminApiError) {
			throw error;
		}
		if (error instanceof DOMException && error.name === "AbortError") {
			throw error;
		}
		throw new AdminApiError(
			"无法连接管理员服务。",
			undefined,
			"NETWORK_ERROR",
		);
	} finally {
		globalThis.clearTimeout(timeout);
		signal?.removeEventListener("abort", forwardAbort);
	}
}

export function getAdminMe(
	accessToken: string,
	signal?: AbortSignal,
): Promise<AdminMe> {
	return requestAdmin<AdminMe>(accessToken, "me", {}, signal);
}

export function getAdminOverview(
	accessToken: string,
	signal?: AbortSignal,
): Promise<AdminOverview> {
	return requestAdmin<AdminOverview>(accessToken, "overview", {}, signal);
}

export function getAdminComments(
	accessToken: string,
	status?: AdminCommentFilter,
	options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<AdminCommentsResult> {
	const payload: JsonObject = {};
	if (status) {
		payload.status = status;
	}
	if (options.limit !== undefined) {
		payload.limit = options.limit;
	}
	if (options.offset !== undefined) {
		payload.offset = options.offset;
	}
	return requestAdmin<AdminCommentsResult>(
		accessToken,
		"comments-list",
		payload,
		options.signal,
	);
}

export function moderateAdminComment(
	accessToken: string,
	input: AdminModerateCommentInput,
	signal?: AbortSignal,
): Promise<AdminModerateCommentResult> {
	return requestAdmin<AdminModerateCommentResult>(
		accessToken,
		"comment-moderate",
		{
			commentId: input.commentId,
			decision: input.decision,
			...(input.note?.trim() ? { note: input.note.trim() } : {}),
		},
		signal,
	);
}

export function getAdminAuditLog(
	accessToken: string,
	options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<AdminAuditLogResult> {
	const payload: JsonObject = {};
	if (options.limit !== undefined) {
		payload.limit = options.limit;
	}
	if (options.offset !== undefined) {
		payload.offset = options.offset;
	}
	return requestAdmin<AdminAuditLogResult>(
		accessToken,
		"audit-list",
		payload,
		options.signal,
	);
}

export function getAdminContent(
	accessToken: string,
	signal?: AbortSignal,
): Promise<AdminContentListResult> {
	return requestAdmin<AdminContentListResult>(
		accessToken,
		"content-list",
		{},
		signal,
	);
}

export function commitAdminContent(
	accessToken: string,
	input: AdminContentCommitInput,
	signal?: AbortSignal,
): Promise<AdminContentCommitResult> {
	return requestAdmin<AdminContentCommitResult>(
		accessToken,
		"content-commit",
		{
			baseHeadSha: input.baseHeadSha,
			...(input.message?.trim() ? { message: input.message.trim() } : {}),
			operations: input.operations,
		},
		signal,
	);
}
