import {
	createClient,
	type SupabaseClient,
	type User,
	type UserIdentity,
} from "npm:@supabase/supabase-js@2.95.0";

type JsonObject = Record<string, unknown>;
type AdminAction =
	| "me"
	| "overview"
	| "comments-list"
	| "comment-moderate"
	| "audit-list"
	| "probe";
type ServiceName = "site" | "blog-api" | "database";
type HealthStatus = "up" | "degraded" | "down";

interface AdminIdentity {
	user: User;
	github: UserIdentity;
	githubId: string;
}

interface PrometheusSample {
	name: string;
	labels: Record<string, string>;
	value: number;
}

interface ServiceHealth {
	ok: boolean;
	status: HealthStatus;
	httpStatus: number | null;
	latencyMs: number | null;
}

interface HealthRow {
	id?: number;
	service: ServiceName;
	status: HealthStatus;
	latency_ms: number | string | null;
	http_status: number | null;
	checked_at: string;
	metrics?: JsonObject | null;
}

interface MonitoringWindow {
	intervalMinutes: number;
	sampleCount: number;
	expectedSamples: number;
	coveragePercent: number;
	minCoveragePercent: number;
	lastMonitorAt: string | null;
	stale: boolean;
	ready: boolean;
}

const MAX_BODY_BYTES = 32 * 1024;
const MAX_METRICS_BYTES = 2 * 1024 * 1024;
const HEALTH_HISTORY_PAGE_SIZE = 1000;
const MONITOR_INTERVAL_MINUTES = 10;
const MONITOR_INTERVAL_MS = MONITOR_INTERVAL_MINUTES * 60 * 1000;
const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
const EXPECTED_MONITOR_SAMPLES = Math.floor(
	HEALTH_WINDOW_MS / MONITOR_INTERVAL_MS,
);
const MIN_MONITOR_COVERAGE_PERCENT = 90;
const MONITOR_STALE_AFTER_MS = 25 * 60 * 1000;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set<AdminAction>([
	"me",
	"overview",
	"comments-list",
	"comment-moderate",
	"audit-list",
	"probe",
]);
const COMMENT_STATUSES = new Set([
	"pending",
	"approved",
	"rejected",
	"spam",
	"all",
]);
const MODERATION_DECISIONS = new Set(["approve", "reject", "spam", "delete"]);

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

let cachedServiceClient: SupabaseClient | null = null;
let cachedAuthClient: SupabaseClient | null = null;

function parseSecretKeyMap(raw: string | undefined): string | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (typeof parsed.default === "string" && parsed.default) {
			return parsed.default;
		}
		for (const value of Object.values(parsed)) {
			if (typeof value === "string" && value) return value;
		}
	} catch {
		return null;
	}
	return null;
}

function getSupabaseUrl(): string {
	const value = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
	if (!value) {
		throw new ApiError(
			503,
			"SERVER_NOT_CONFIGURED",
			"Admin service is not configured.",
		);
	}
	return value;
}

function getSecretKey(): string {
	const value =
		Deno.env.get("SUPABASE_SECRET_KEY") ??
		parseSecretKeyMap(Deno.env.get("SUPABASE_SECRET_KEYS")) ??
		Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	if (!value) {
		throw new ApiError(
			503,
			"SERVER_NOT_CONFIGURED",
			"Admin service is not configured.",
		);
	}
	return value;
}

function getPublishableKey(): string {
	const value =
		Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
		parseSecretKeyMap(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")) ??
		Deno.env.get("SUPABASE_ANON_KEY");
	if (!value) {
		throw new ApiError(
			503,
			"SERVER_NOT_CONFIGURED",
			"Admin authentication is not configured.",
		);
	}
	return value;
}

function getServiceClient(): SupabaseClient {
	if (cachedServiceClient) return cachedServiceClient;
	cachedServiceClient = createClient(getSupabaseUrl(), getSecretKey(), {
		auth: {
			autoRefreshToken: false,
			detectSessionInUrl: false,
			persistSession: false,
		},
	});
	return cachedServiceClient;
}

function getAuthClient(): SupabaseClient {
	if (cachedAuthClient) return cachedAuthClient;
	cachedAuthClient = createClient(getSupabaseUrl(), getPublishableKey(), {
		auth: {
			autoRefreshToken: false,
			detectSessionInUrl: false,
			persistSession: false,
		},
	});
	return cachedAuthClient;
}

function normalizeOrigin(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

function allowedOrigins(): Set<string> {
	const configured = Deno.env.get("ALLOWED_ORIGINS");
	const values = configured?.trim()
		? configured.split(",")
		: [
				"https://f389722475.github.io",
				"http://localhost:4321",
				"http://127.0.0.1:4321",
			];
	return new Set(
		values
			.map((value) => normalizeOrigin(value.trim()))
			.filter((value): value is string => value !== null),
	);
}

function requireAllowedOrigin(request: Request): string {
	const raw = request.headers.get("origin");
	const origin = raw ? normalizeOrigin(raw) : null;
	if (!origin || !allowedOrigins().has(origin)) {
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
			"authorization, apikey, content-type, x-client-info, x-monitor-token",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Max-Age": "86400",
		"Cache-Control": "no-store, max-age=0",
		"Content-Type": "application/json; charset=utf-8",
		"X-Content-Type-Options": "nosniff",
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

function success(origin: string | null, data: JsonObject): Response {
	return jsonResponse(origin, 200, { ok: true, data });
}

function failure(origin: string | null, error: ApiError): Response {
	return jsonResponse(origin, error.status, {
		ok: false,
		error: { code: error.code, message: error.message },
	});
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	const result = value.trim();
	if (!result || result.length > maxLength) {
		throw new ApiError(
			400,
			"INVALID_FIELD",
			`${field} has an invalid length.`,
		);
	}
	return result;
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

function integer(
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

async function parseBody(request: Request): Promise<JsonObject> {
	const type = request.headers.get("content-type")?.toLowerCase() ?? "";
	if (!type.includes("application/json")) {
		throw new ApiError(415, "JSON_REQUIRED", "Content-Type must be JSON.");
	}
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw new ApiError(413, "BODY_TOO_LARGE", "Request body is too large.");
	}
	const raw = await request.text();
	if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
		throw new ApiError(413, "BODY_TOO_LARGE", "Request body is too large.");
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (!isObject(value)) throw new Error("not object");
		return value;
	} catch {
		throw new ApiError(
			400,
			"INVALID_JSON",
			"Request body is invalid JSON.",
		);
	}
}

function actionFrom(body: JsonObject): AdminAction {
	const raw = requiredString(body.action, "action", 80).toLowerCase();
	if (!ACTIONS.has(raw as AdminAction)) {
		throw new ApiError(400, "UNKNOWN_ACTION", "Unsupported admin action.");
	}
	return raw as AdminAction;
}

function bearerToken(request: Request): string {
	const header = request.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(header);
	if (!match?.[1]) {
		throw new ApiError(
			401,
			"AUTH_REQUIRED",
			"Administrator sign-in is required.",
		);
	}
	return match[1].trim();
}

function configuredAdminIds(): Set<string> {
	const raw = Deno.env.get("ADMIN_GITHUB_IDS")?.trim() || "20443093";
	return new Set(
		raw
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);
}

function providerId(identity: UserIdentity): string | null {
	// New GoTrue payloads call this provider_id.  supabase-js 2.95 still types
	// the same provider-owned value as `id` and exposes the internal UUID as
	// `identity_id`, so accept both wire formats after getUser() verification.
	const current = (identity as UserIdentity & { provider_id?: unknown })
		.provider_id;
	if (typeof current === "string" && current) return current;
	if (typeof identity.id === "string" && identity.id) return identity.id;
	const metadata = isObject(identity.identity_data)
		? identity.identity_data
		: {};
	const subject = metadata.sub;
	return typeof subject === "string" || typeof subject === "number"
		? String(subject)
		: null;
}

async function requireAdmin(request: Request): Promise<AdminIdentity> {
	const token = bearerToken(request);
	const { data, error } = await getAuthClient().auth.getUser(token);
	if (error || !data.user) {
		throw new ApiError(
			401,
			"INVALID_SESSION",
			"Administrator session is invalid or expired.",
		);
	}
	const allowed = configuredAdminIds();
	const github = data.user.identities?.find((identity) => {
		const id = providerId(identity);
		return identity.provider === "github" && id !== null && allowed.has(id);
	});
	if (!github) {
		throw new ApiError(
			403,
			"ADMIN_REQUIRED",
			"This GitHub account is not an administrator.",
		);
	}
	return { user: data.user, github, githubId: providerId(github)! };
}

function timingSafeEqual(left: string, right: string): boolean {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	let difference = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index += 1) {
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
}

function requireMonitorToken(request: Request): void {
	const expected =
		Deno.env.get("MONITOR_TOKEN") ??
		Deno.env.get("OPS_MONITOR_TOKEN") ??
		"";
	const supplied = request.headers.get("x-monitor-token") ?? "";
	if (!expected) {
		throw new ApiError(
			503,
			"MONITOR_NOT_CONFIGURED",
			"Monitoring probe is not configured.",
		);
	}
	if (!supplied || !timingSafeEqual(supplied, expected)) {
		throw new ApiError(
			401,
			"INVALID_MONITOR_TOKEN",
			"Monitoring token is invalid.",
		);
	}
}

function round(value: number | null, digits = 2): number | null {
	if (value === null || !Number.isFinite(value)) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function numberValue(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const result = Number(value);
	return Number.isFinite(result) && result >= 0 ? result : null;
}

function percent(used: number | null, total: number | null): number | null {
	if (used === null || total === null || total <= 0) return null;
	return round(Math.max(0, Math.min(100, (used / total) * 100)));
}

function decodePrometheusLabel(value: string): string {
	return value
		.replace(/\\n/g, "\n")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

function parsePrometheus(text: string): PrometheusSample[] {
	const samples: PrometheusSample[] = [];
	const linePattern =
		/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/;
	const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = linePattern.exec(line);
		if (!match) continue;
		const value = Number(match[3]);
		if (!Number.isFinite(value)) continue;
		const labels: Record<string, string> = {};
		if (match[2]) {
			labelPattern.lastIndex = 0;
			for (
				let label = labelPattern.exec(match[2]);
				label;
				label = labelPattern.exec(match[2])
			) {
				labels[label[1]] = decodePrometheusLabel(label[2]);
			}
		}
		samples.push({ name: match[1], labels, value });
	}
	return samples;
}

function matchingSamples(
	samples: PrometheusSample[],
	name: string,
	labels: Record<string, string> = {},
): PrometheusSample[] {
	return samples.filter(
		(sample) =>
			sample.name === name &&
			Object.entries(labels).every(
				([key, value]) => sample.labels[key] === value,
			),
	);
}

function metric(
	samples: PrometheusSample[],
	name: string,
	labels: Record<string, string> = {},
): number | null {
	return matchingSamples(samples, name, labels)[0]?.value ?? null;
}

async function fetchMetrics(): Promise<{
	samples: PrometheusSample[];
	latencyMs: number;
}> {
	const started = performance.now();
	const credentials = btoa(`service_role:${getSecretKey()}`);
	let response: Response;
	try {
		response = await fetch(
			`${getSupabaseUrl()}/customer/v1/privileged/metrics`,
			{
				headers: {
					Authorization: `Basic ${credentials}`,
					Accept: "text/plain",
				},
				signal: AbortSignal.timeout(8000),
			},
		);
	} catch {
		throw new ApiError(
			503,
			"METRICS_UNAVAILABLE",
			"Infrastructure metrics are unavailable.",
		);
	}
	if (!response.ok) {
		throw new ApiError(
			503,
			"METRICS_UNAVAILABLE",
			"Infrastructure metrics are unavailable.",
		);
	}
	const text = await response.text();
	if (new TextEncoder().encode(text).byteLength > MAX_METRICS_BYTES) {
		throw new ApiError(
			503,
			"METRICS_INVALID",
			"Infrastructure metrics response is too large.",
		);
	}
	return {
		samples: parsePrometheus(text),
		latencyMs: performance.now() - started,
	};
}

async function probeHttp(
	url: string,
	options: RequestInit,
): Promise<ServiceHealth> {
	const started = performance.now();
	try {
		const response = await fetch(url, {
			...options,
			cache: "no-store",
			signal: AbortSignal.timeout(5000),
		});
		const latencyMs = performance.now() - started;
		const ok =
			response.ok || (response.status >= 300 && response.status < 400);
		return {
			ok,
			status: ok ? (latencyMs > 1500 ? "degraded" : "up") : "down",
			httpStatus: response.status,
			latencyMs: round(latencyMs, 3),
		};
	} catch {
		return {
			ok: false,
			status: "down",
			httpStatus: null,
			latencyMs: round(performance.now() - started, 3),
		};
	}
}

async function probeBlogApi(origin: string): Promise<ServiceHealth> {
	const started = performance.now();
	try {
		const response = await fetch(
			`${getSupabaseUrl()}/functions/v1/blog-api`,
			{
				method: "POST",
				headers: {
					Accept: "application/json",
					apikey: getPublishableKey(),
					"Content-Type": "application/json",
					Origin: origin,
				},
				body: JSON.stringify({ action: "health" }),
				cache: "no-store",
				signal: AbortSignal.timeout(5000),
			},
		);
		const latencyMs = performance.now() - started;
		let payload: unknown = null;
		try {
			const text = await response.text();
			if (new TextEncoder().encode(text).byteLength <= 8192) {
				payload = JSON.parse(text) as unknown;
			}
		} catch {
			payload = null;
		}
		const envelope = isObject(payload) ? payload : {};
		const data = isObject(envelope.data) ? envelope.data : {};
		const ok =
			response.ok &&
			envelope.ok === true &&
			data.status === "ok" &&
			data.database === "reachable";
		return {
			ok,
			status: ok ? (latencyMs > 1500 ? "degraded" : "up") : "down",
			httpStatus: response.status,
			latencyMs: round(latencyMs, 3),
		};
	} catch {
		return {
			ok: false,
			status: "down",
			httpStatus: null,
			latencyMs: round(performance.now() - started, 3),
		};
	}
}

function siteUrl(): string {
	return (
		Deno.env.get("SITE_URL")?.trim() || "https://f389722475.github.io"
	).replace(/\/+$/, "");
}

async function previousCpuCounters(): Promise<{
	total: number;
	idle: number;
} | null> {
	const { data, error } = await getServiceClient()
		.from("ops_health_samples")
		.select("metrics")
		.eq("service", "database")
		.order("checked_at", { ascending: false })
		.limit(20);
	if (error) return null;
	for (const row of (data ?? []) as JsonObject[]) {
		if (!isObject(row.metrics)) continue;
		const total = numberValue(row.metrics.cpu_total_seconds);
		const idle = numberValue(row.metrics.cpu_idle_seconds);
		if (total !== null && idle !== null) return { total, idle };
	}
	return null;
}

function cpuCounters(samples: PrometheusSample[]): {
	total: number;
	idle: number;
} {
	const cpu = matchingSamples(samples, "node_cpu_seconds_total");
	return {
		total: cpu.reduce((sum, sample) => sum + sample.value, 0),
		idle: cpu
			.filter(
				(sample) =>
					sample.labels.mode === "idle" ||
					sample.labels.mode === "iowait",
			)
			.reduce((sum, sample) => sum + sample.value, 0),
	};
}

function cpuPercent(
	current: { total: number; idle: number },
	previous: { total: number; idle: number } | null,
): number | null {
	if (!previous) return null;
	const totalDelta = current.total - previous.total;
	const idleDelta = current.idle - previous.idle;
	if (totalDelta <= 0 || idleDelta < 0) return null;
	return round(
		Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)),
	);
}

function infrastructureFrom(
	samples: PrometheusSample[],
	dashboard: JsonObject,
	previousCpu: { total: number; idle: number } | null,
): { publicData: JsonObject; storedData: JsonObject } {
	const totalMemory = metric(samples, "node_memory_MemTotal_bytes", {
		service_type: "db",
	});
	const availableMemory = metric(samples, "node_memory_MemAvailable_bytes", {
		service_type: "db",
	});
	const usedMemory =
		totalMemory !== null && availableMemory !== null
			? Math.max(0, totalMemory - availableMemory)
			: null;
	const diskTotal = metric(samples, "node_filesystem_size_bytes", {
		mountpoint: "/data",
	});
	const diskAvailable = metric(samples, "node_filesystem_avail_bytes", {
		mountpoint: "/data",
	});
	const diskUsed =
		diskTotal !== null && diskAvailable !== null
			? Math.max(0, diskTotal - diskAvailable)
			: null;
	const counters = cpuCounters(samples);
	const database = isObject(dashboard.database) ? dashboard.database : {};
	const storage = isObject(dashboard.storage) ? dashboard.storage : {};
	const connections =
		metric(samples, "pg_stat_database_num_backends", {
			service_type: "postgresql",
		}) ?? numberValue(database.connections);
	const maxConnections =
		metric(samples, "max_connections_connection_count", {
			service_type: "postgresql",
		}) ?? numberValue(database.max_connections);
	const databaseSize =
		metric(samples, "pg_database_size_bytes", { datname: "postgres" }) ??
		numberValue(database.size_bytes);
	const walMb = metric(samples, "pg_wal_size_mb", {
		service_type: "postgresql",
	});
	const pgUp = metric(samples, "pg_up", { service_type: "postgresql" });
	const exporterError = metric(samples, "pg_exporter_last_scrape_error", {
		service_type: "postgresql",
	});
	const deadlocks = metric(samples, "pg_stat_database_deadlocks_total", {
		service_type: "postgresql",
	});
	const poolMax = metric(samples, "pgrst_db_pool_max", {
		service_type: "postgrest",
	});
	const poolAvailable = metric(samples, "pgrst_db_pool_available", {
		service_type: "postgrest",
	});
	const poolWaiting = metric(samples, "pgrst_db_pool_waiting", {
		service_type: "postgrest",
	});
	const poolUsed =
		poolMax !== null && poolAvailable !== null
			? Math.max(0, poolMax - poolAvailable)
			: null;
	const publicData: JsonObject = {
		memory: {
			totalBytes: totalMemory,
			availableBytes: availableMemory,
			usedBytes: usedMemory,
			usedPercent: percent(usedMemory, totalMemory),
		},
		disk: {
			totalBytes: diskTotal,
			availableBytes: diskAvailable,
			usedBytes: diskUsed,
			usedPercent: percent(diskUsed, diskTotal),
			mountpoint: "/data",
		},
		database: {
			sizeBytes: databaseSize,
			connections,
			maxConnections,
			connectionPercent: percent(connections, maxConnections),
			cacheHitPercent: numberValue(database.cache_hit_percent),
			walBytes: walMb === null ? null : Math.round(walMb * 1024 * 1024),
			status: database.status ?? "unknown",
			pgUp: pgUp === null ? null : pgUp === 1,
			metricsExporterOk:
				exporterError === null ? null : exporterError === 0,
			deadlocks,
			pool: {
				max: poolMax,
				available: poolAvailable,
				used: poolUsed,
				usedPercent: percent(poolUsed, poolMax),
				waiting: poolWaiting,
			},
		},
		load: {
			one: metric(samples, "node_load1", { service_type: "db" }),
			five: metric(samples, "node_load5", { service_type: "db" }),
			fifteen: metric(samples, "node_load15", { service_type: "db" }),
		},
		cpu: {
			usedPercent: cpuPercent(counters, previousCpu),
			note: previousCpu ? null : "首个样本暂无 CPU 差值。",
		},
		storage: {
			objects: numberValue(storage.objects) ?? 0,
			sizeBytes: numberValue(storage.size_bytes) ?? 0,
		},
	};
	return {
		publicData,
		storedData: {
			cpu_total_seconds: counters.total,
			cpu_idle_seconds: counters.idle,
			memory_used_percent: percent(usedMemory, totalMemory),
			disk_used_percent: percent(diskUsed, diskTotal),
			connections,
			max_connections: maxConnections,
			load_1: metric(samples, "node_load1", { service_type: "db" }),
		},
	};
}

function p95(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)], 2);
}

function monitorSamplesByInterval(rows: HealthRow[]): HealthRow[] {
	const buckets = new Map<string, HealthRow>();
	for (const row of rows) {
		const checkedAt = new Date(row.checked_at).getTime();
		if (!Number.isFinite(checkedAt)) continue;
		const bucket = Math.floor(checkedAt / MONITOR_INTERVAL_MS);
		// A retried workflow can complete twice in one ten-minute interval. Keep
		// the latest result so a retry cannot over-weight availability or P95.
		buckets.set(`${row.service}:${bucket}`, row);
	}
	return [...buckets.values()].sort((left, right) => {
		const timeDifference =
			new Date(left.checked_at).getTime() -
			new Date(right.checked_at).getTime();
		return timeDifference || Number(left.id ?? 0) - Number(right.id ?? 0);
	});
}

function summarizeHealth(
	rows: HealthRow[],
	now = Date.now(),
): {
	uptime24h: Record<string, number | null>;
	p95Latency24h: Record<string, number | null>;
	monitoring24h: MonitoringWindow;
} {
	const uptime24h: Record<string, number | null> = {
		site: null,
		blogApi: null,
		database: null,
	};
	const p95Latency24h: Record<string, number | null> = {
		site: null,
		blogApi: null,
		database: null,
	};
	const serviceNames = ["site", "blog-api", "database"] as ServiceName[];
	const sampleCounts = serviceNames.map(
		(service) => rows.filter((row) => row.service === service).length,
	);
	const sampleCount = Math.min(...sampleCounts);
	const coveragePercent = Math.min(
		100,
		Math.round((sampleCount / EXPECTED_MONITOR_SAMPLES) * 10_000) / 100,
	);
	const lastMonitorTime = rows.reduce<number | null>((latest, row) => {
		const value = new Date(row.checked_at).getTime();
		if (!Number.isFinite(value)) return latest;
		return latest === null ? value : Math.max(latest, value);
	}, null);
	const lastMonitorAt =
		lastMonitorTime === null
			? null
			: new Date(lastMonitorTime).toISOString();
	const stale =
		lastMonitorTime !== null &&
		now - lastMonitorTime > MONITOR_STALE_AFTER_MS;
	const ready = !stale && coveragePercent >= MIN_MONITOR_COVERAGE_PERCENT;
	const monitoring24h: MonitoringWindow = {
		intervalMinutes: MONITOR_INTERVAL_MINUTES,
		sampleCount,
		expectedSamples: EXPECTED_MONITOR_SAMPLES,
		coveragePercent,
		minCoveragePercent: MIN_MONITOR_COVERAGE_PERCENT,
		lastMonitorAt,
		stale,
		ready,
	};
	for (const service of serviceNames) {
		const selected = rows.filter((row) => row.service === service);
		const key = service === "blog-api" ? "blogApi" : service;
		if (ready && selected.length > 0) {
			uptime24h[key] = round(
				(selected.filter((row) => row.status !== "down").length /
					selected.length) *
					100,
			);
			p95Latency24h[key] = p95(
				selected
					.map((row) => numberValue(row.latency_ms))
					.filter((value): value is number => value !== null),
			);
		}
	}
	return { uptime24h, p95Latency24h, monitoring24h };
}

async function monitorHealthHistorySince(since: string): Promise<HealthRow[]> {
	const rows: HealthRow[] = [];
	let offset = 0;

	for (;;) {
		const { data, error } = await getServiceClient()
			.from("ops_health_samples")
			.select(
				"id,service,status,latency_ms,http_status,checked_at,metrics",
			)
			.gte("checked_at", since)
			.eq("metrics->>trigger", "monitor")
			.order("checked_at", { ascending: true })
			.order("id", { ascending: true })
			.range(offset, offset + HEALTH_HISTORY_PAGE_SIZE - 1);

		if (error) {
			throw new ApiError(
				503,
				"DATABASE_UNAVAILABLE",
				"Health history is unavailable.",
			);
		}

		const page = (data ?? []) as unknown as HealthRow[];
		rows.push(...page);
		if (page.length < HEALTH_HISTORY_PAGE_SIZE) break;
		offset += page.length;
	}

	return rows;
}

function overallStatus(
	services: Record<string, ServiceHealth>,
	metricsOk: boolean,
): string {
	const statuses = Object.values(services).map((service) => service.status);
	if (statuses.includes("down")) return "down";
	if (!metricsOk || statuses.includes("degraded")) return "degraded";
	return "healthy";
}

async function collectOverview(
	trigger: "admin" | "monitor",
): Promise<JsonObject> {
	const edgeStarted = performance.now();
	const site = siteUrl();
	const siteOrigin = new URL(site).origin;
	const databasePromise = (async () => {
		const started = performance.now();
		const result = await getServiceClient().rpc("blog_admin_dashboard");
		return { result, latencyMs: performance.now() - started };
	})();
	const metricsPromise = fetchMetrics().catch(() => null);
	const previousCpuPromise = previousCpuCounters();
	const siteProbePromise = probeHttp(`${site}/`, {
		method: "HEAD",
		redirect: "manual",
	});
	const blogProbePromise = probeBlogApi(siteOrigin);

	const [databaseCall, metricsResult, previousCpu, siteHealth, blogHealth] =
		await Promise.all([
			databasePromise,
			metricsPromise,
			previousCpuPromise,
			siteProbePromise,
			blogProbePromise,
		]);
	const databaseResult = databaseCall.result;
	const databaseMs = databaseCall.latencyMs;
	if (databaseResult.error || !isObject(databaseResult.data)) {
		console.warn(
			`[blog-admin-api] dashboard RPC failed (${databaseResult.error?.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Admin dashboard data is unavailable.",
		);
	}
	const dashboard = databaseResult.data;
	const infrastructure = metricsResult
		? infrastructureFrom(metricsResult.samples, dashboard, previousCpu)
		: {
				publicData: {
					memory: {},
					disk: { mountpoint: "/data" },
					database: isObject(dashboard.database)
						? dashboard.database
						: {},
					load: {},
					cpu: {
						usedPercent: null,
						note: "Supabase Metrics API 暂时不可用。",
					},
					storage: isObject(dashboard.storage)
						? dashboard.storage
						: {},
				},
				storedData: { metrics_unavailable: true },
			};
	const databaseStatus =
		isObject(dashboard.database) &&
		dashboard.database.status === "read-only"
			? "degraded"
			: databaseMs > 1500
				? "degraded"
				: "up";
	const databaseHealth: ServiceHealth = {
		ok: true,
		status: databaseStatus,
		httpStatus: null,
		latencyMs: round(databaseMs, 3),
	};
	const services = {
		site: siteHealth,
		blogApi: blogHealth,
		database: databaseHealth,
	};
	const batchId = crypto.randomUUID();
	const checkedAt = new Date().toISOString();
	const rows = [
		{
			batch_id: batchId,
			service: "site",
			status: siteHealth.status,
			latency_ms: siteHealth.latencyMs,
			http_status: siteHealth.httpStatus,
			metrics: { trigger },
			checked_at: checkedAt,
		},
		{
			batch_id: batchId,
			service: "blog-api",
			status: blogHealth.status,
			latency_ms: blogHealth.latencyMs,
			http_status: blogHealth.httpStatus,
			metrics: { trigger },
			checked_at: checkedAt,
		},
		{
			batch_id: batchId,
			service: "database",
			status: databaseHealth.status,
			latency_ms: databaseHealth.latencyMs,
			http_status: null,
			metrics: { ...infrastructure.storedData, trigger },
			checked_at: checkedAt,
		},
	];
	const insertResult = await getServiceClient()
		.from("ops_health_samples")
		.insert(rows);
	if (insertResult.error) {
		console.warn(
			`[blog-admin-api] health sample insert failed (${insertResult.error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Health history could not be recorded.",
		);
	}
	// Keep enough history for future 30-day charts without allowing an
	// unattended probe to grow the operational table forever.
	const retentionCutoff = new Date(
		Date.now() - 30 * 24 * 60 * 60 * 1000,
	).toISOString();
	const cleanup = await getServiceClient()
		.from("ops_health_samples")
		.delete()
		.lt("checked_at", retentionCutoff);
	if (cleanup.error) {
		console.warn(
			`[blog-admin-api] health retention cleanup failed (${cleanup.error.code ?? "unknown"})`,
		);
	}

	const since = new Date(Date.now() - HEALTH_WINDOW_MS).toISOString();
	// Availability and P95 must be based on the fixed-interval monitor only.
	// Admin refreshes are useful for current state, but would otherwise heavily
	// bias the 24-hour aggregate. Paginate so the full window is retained even
	// if the PostgREST response limit changes or checks are retried.
	const healthRows = monitorSamplesByInterval(
		await monitorHealthHistorySince(since),
	);
	const healthSummary = summarizeHealth(healthRows);
	const currentStatus = overallStatus(services, metricsResult !== null);
	const status =
		healthSummary.monitoring24h.stale && currentStatus === "healthy"
			? "degraded"
			: currentStatus;
	const content = isObject(dashboard.content) ? dashboard.content : {};
	const comments = isObject(dashboard.comments) ? dashboard.comments : {};
	return {
		sampledAt: checkedAt,
		status,
		content: {
			articles: numberValue(content.articles) ?? 0,
			diaries: numberValue(content.diaries) ?? 0,
			published: numberValue(content.published) ?? 0,
			drafts: numberValue(content.drafts) ?? 0,
			views: numberValue(content.views) ?? 0,
			likes: numberValue(content.likes) ?? 0,
			shares: numberValue(content.shares) ?? 0,
			comments: numberValue(content.comments) ?? 0,
		},
		comments: {
			pending: numberValue(comments.pending) ?? 0,
			approved: numberValue(comments.approved) ?? 0,
			rejected: numberValue(comments.rejected) ?? 0,
			spam: numberValue(comments.spam) ?? 0,
			oldestPendingAt: comments.oldest_pending_at ?? null,
		},
		infrastructure: infrastructure.publicData,
		latency: {
			edgeMs: round(performance.now() - edgeStarted, 3),
			databaseMs: round(databaseMs, 3),
			siteMs: siteHealth.latencyMs,
			blogApiMs: blogHealth.latencyMs,
		},
		services,
		uptime24h: healthSummary.uptime24h,
		p95Latency24h: healthSummary.p95Latency24h,
		monitoring24h: healthSummary.monitoring24h,
		history: healthRows.map((row) => ({
			checkedAt: row.checked_at,
			service: row.service,
			status: row.status,
			latencyMs: numberValue(row.latency_ms),
			httpStatus: row.http_status,
		})),
		source: {
			metrics: "supabase-metrics-api",
			metricsAvailable: metricsResult !== null,
			metricsLatencyMs: metricsResult
				? round(metricsResult.latencyMs, 3)
				: null,
			refreshSeconds: 60,
		},
	};
}

function identityDisplay(identity: UserIdentity): {
	login: string | null;
	avatarUrl: string | null;
} {
	const metadata = isObject(identity.identity_data)
		? identity.identity_data
		: {};
	const login =
		(typeof metadata.user_name === "string" && metadata.user_name) ||
		(typeof metadata.preferred_username === "string" &&
			metadata.preferred_username) ||
		(typeof metadata.login === "string" && metadata.login) ||
		null;
	const avatarUrl =
		typeof metadata.avatar_url === "string" ? metadata.avatar_url : null;
	return { login, avatarUrl };
}

function meAction(admin: AdminIdentity): JsonObject {
	const display = identityDisplay(admin.github);
	return {
		isAdmin: true,
		user: {
			id: admin.user.id,
			githubId: admin.githubId,
			login: display.login,
			avatarUrl: display.avatarUrl,
		},
	};
}

async function commentCounts(): Promise<JsonObject> {
	const statuses = ["pending", "approved", "rejected", "spam"] as const;
	const queries = statuses.map((status) =>
		getServiceClient()
			.from("comments")
			.select("id", { count: "exact", head: true })
			.eq("status", status),
	);
	queries.push(
		getServiceClient()
			.from("comments")
			.select("id", { count: "exact", head: true }),
	);
	const results = await Promise.all(queries);
	if (results.some((result) => result.error)) {
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Comment counts are unavailable.",
		);
	}
	return {
		pending: results[0].count ?? 0,
		approved: results[1].count ?? 0,
		rejected: results[2].count ?? 0,
		spam: results[3].count ?? 0,
		all: results[4].count ?? 0,
	};
}

async function commentsListAction(body: JsonObject): Promise<JsonObject> {
	const status = (
		optionalString(body.status, "status", 20) ?? "pending"
	).toLowerCase();
	if (!COMMENT_STATUSES.has(status)) {
		throw new ApiError(
			400,
			"INVALID_STATUS",
			"Comment status filter is invalid.",
		);
	}
	const limit = integer(body.limit, 30, 1, 100);
	const offset = integer(body.offset, 0, 0, 5000);
	let query = getServiceClient()
		.from("comments")
		.select(
			"id,content_id,parent_id,author_name,author_website,body,status,created_at,updated_at,moderated_at,moderation_note",
			{ count: "exact" },
		)
		.order("created_at", { ascending: status === "pending" })
		.order("id", { ascending: status === "pending" })
		.range(offset, offset + limit - 1);
	if (status !== "all") query = query.eq("status", status);
	const [{ data, error, count }, counts] = await Promise.all([
		query,
		commentCounts(),
	]);
	if (error) {
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Comment queue is unavailable.",
		);
	}
	const rows = (data ?? []) as JsonObject[];
	const ids = [...new Set(rows.map((row) => String(row.content_id)))];
	const contentMap = new Map<string, JsonObject>();
	if (ids.length > 0) {
		const contentResult = await getServiceClient()
			.from("content_entries")
			.select("id,title,canonical_path")
			.in("id", ids);
		if (contentResult.error) {
			throw new ApiError(
				503,
				"DATABASE_UNAVAILABLE",
				"Comment content is unavailable.",
			);
		}
		for (const item of (contentResult.data ?? []) as JsonObject[]) {
			contentMap.set(String(item.id), item);
		}
	}
	return {
		items: rows.map((row) => {
			const post = contentMap.get(String(row.content_id));
			return {
				id: row.id,
				contentId: row.content_id,
				parentId: row.parent_id,
				post: {
					title: post?.title ?? "",
					canonicalPath: post?.canonical_path ?? "",
				},
				authorName: row.author_name,
				authorWebsite: row.author_website,
				body: row.body,
				status: row.status,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				moderatedAt: row.moderated_at,
				moderationNote: row.moderation_note,
			};
		}),
		pagination: { limit, offset, total: count ?? 0 },
		counts,
	};
}

async function moderateCommentAction(
	body: JsonObject,
	admin: AdminIdentity,
): Promise<JsonObject> {
	const commentId = requiredString(
		body.commentId ?? body.comment_id,
		"commentId",
		64,
	);
	if (!UUID_PATTERN.test(commentId)) {
		throw new ApiError(400, "INVALID_COMMENT", "commentId must be a UUID.");
	}
	const decision = requiredString(
		body.decision,
		"decision",
		20,
	).toLowerCase();
	if (!MODERATION_DECISIONS.has(decision)) {
		throw new ApiError(
			400,
			"INVALID_DECISION",
			"Moderation decision is invalid.",
		);
	}
	const note = optionalString(body.note, "note", 500);
	const requestId = crypto.randomUUID();
	const { data, error } = await getServiceClient().rpc(
		"blog_admin_moderate_comment",
		{
			p_actor_provider: "github",
			p_actor_provider_id: admin.githubId,
			p_actor_user_id: admin.user.id,
			p_comment_id: commentId,
			p_decision: decision,
			p_note: note,
			p_request_id: requestId,
		},
	);
	if (error) {
		if (error.code === "P0002") {
			throw new ApiError(
				404,
				"COMMENT_NOT_FOUND",
				"Comment was not found.",
			);
		}
		if (error.code === "22023") {
			throw new ApiError(
				400,
				"INVALID_MODERATION",
				"Moderation request is invalid.",
			);
		}
		console.warn(
			`[blog-admin-api] moderation failed (${error.code ?? "unknown"})`,
		);
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Comment could not be moderated.",
		);
	}
	if (!isObject(data)) {
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Moderation result is invalid.",
		);
	}
	return {
		commentId: data.comment_id,
		decision: data.decision,
		status: data.status ?? null,
		deleted: data.deleted === true,
		moderatedAt: data.moderated_at,
		counts: data.counts,
	};
}

async function auditListAction(body: JsonObject): Promise<JsonObject> {
	const limit = integer(body.limit, 30, 1, 100);
	const offset = integer(body.offset, 0, 0, 5000);
	const { data, error, count } = await getServiceClient()
		.from("admin_audit_log")
		.select(
			"id,actor_provider_id,action,target_type,target_id,old_status,new_status,details,created_at",
			{ count: "exact" },
		)
		.order("created_at", { ascending: false })
		.order("id", { ascending: false })
		.range(offset, offset + limit - 1);
	if (error) {
		throw new ApiError(
			503,
			"DATABASE_UNAVAILABLE",
			"Audit history is unavailable.",
		);
	}
	return {
		items: ((data ?? []) as JsonObject[]).map((row) => ({
			id: row.id,
			actorProviderId: row.actor_provider_id,
			action: row.action,
			targetType: row.target_type,
			targetId: row.target_id,
			oldStatus: row.old_status,
			newStatus: row.new_status,
			details: row.details,
			createdAt: row.created_at,
		})),
		pagination: { limit, offset, total: count ?? 0 },
	};
}

function probeResponse(overview: JsonObject): JsonObject {
	return {
		sampledAt: overview.sampledAt,
		status: overview.status,
		infrastructure: overview.infrastructure,
		latency: overview.latency,
		services: overview.services,
		uptime24h: overview.uptime24h,
		p95Latency24h: overview.p95Latency24h,
		monitoring24h: overview.monitoring24h,
		source: overview.source,
	};
}

Deno.serve(async (request: Request) => {
	let origin: string | null = null;
	try {
		if (request.method === "OPTIONS") {
			origin = requireAllowedOrigin(request);
			return new Response(null, {
				status: 204,
				headers: responseHeaders(origin),
			});
		}
		if (request.method !== "POST") {
			throw new ApiError(
				405,
				"METHOD_NOT_ALLOWED",
				"Use POST for admin actions.",
			);
		}
		const body = await parseBody(request);
		const action = actionFrom(body);
		if (action === "probe") {
			requireMonitorToken(request);
			return success(
				null,
				probeResponse(await collectOverview("monitor")),
			);
		}

		origin = requireAllowedOrigin(request);
		const admin = await requireAdmin(request);
		let data: JsonObject;
		switch (action) {
			case "me":
				data = meAction(admin);
				break;
			case "overview":
				data = await collectOverview("admin");
				break;
			case "comments-list":
				data = await commentsListAction(body);
				break;
			case "comment-moderate":
				data = await moderateCommentAction(body, admin);
				break;
			case "audit-list":
				data = await auditListAction(body);
				break;
			default:
				throw new ApiError(
					400,
					"UNKNOWN_ACTION",
					"Unsupported admin action.",
				);
		}
		return success(origin, data);
	} catch (error) {
		if (error instanceof ApiError) return failure(origin, error);
		console.error("[blog-admin-api] unexpected internal error");
		return failure(
			origin,
			new ApiError(
				500,
				"INTERNAL_ERROR",
				"An unexpected error occurred.",
			),
		);
	}
});
