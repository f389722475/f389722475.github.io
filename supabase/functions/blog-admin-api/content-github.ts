import { parse, stringify } from "npm:yaml@2.9.0";

export type ContentJsonObject = Record<string, unknown>;

export class ContentApiError extends Error {
	status: number;
	code: string;
	details?: ContentJsonObject;

	constructor(
		status: number,
		code: string,
		message: string,
		details?: ContentJsonObject,
	) {
		super(message);
		this.name = "ContentApiError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

interface ContentActor {
	userId: string;
	githubId: string;
}

interface GitHubConfig {
	token: string;
	owner: string;
	repo: string;
	branch: string;
	contentRoot: string;
	trashRoot: string;
}

interface GitHubTreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	sha: string;
	size?: number;
}

interface GitHubSnapshot {
	headSha: string;
	treeSha: string;
	entries: GitHubTreeEntry[];
}

interface StudioPost {
	id: string;
	sha: string;
	title: string;
	slug: string;
	description: string;
	body: string;
	image: string;
	tags: string[];
	category: string;
	kind: "article" | "diary";
	status: "published" | "draft" | "scheduled" | "trash";
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
	trashPath?: string;
	trashedAt?: string;
}

interface WorkingPost {
	post: StudioPost;
	fullPath: string;
	frontmatter: ContentJsonObject;
	source: string;
}

interface ContentState {
	snapshot: GitHubSnapshot;
	active: Map<string, WorkingPost>;
	trash: Map<string, WorkingPost>;
	originalSources: Map<string, string>;
}

interface TreeChange {
	path: string;
	mode: "100644";
	type: "blob";
	sha: string | null;
}

const GITHUB_API = "https://api.github.com";
const MAX_POSTS = 300;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OPERATIONS = 50;
const MAX_CHANGED_FILES = 150;
const MARKDOWN_EXTENSIONS = [".md"] as const;
const STATUS_VALUES = new Set(["published", "draft", "scheduled"]);
const KIND_VALUES = new Set(["article", "diary"]);

function isObject(value: unknown): value is ContentJsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretFromMap(raw: string | undefined): string | null {
	if (!raw) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (typeof parsed.default === "string" && parsed.default) {
			return parsed.default;
		}
		for (const value of Object.values(parsed)) {
			if (typeof value === "string" && value) {
				return value;
			}
		}
	} catch {
		return null;
	}
	return null;
}

function configuredValue(name: string, fallback?: string): string {
	const value = Deno.env.get(name)?.trim() || fallback;
	if (!value) {
		throw new ContentApiError(
			503,
			"GITHUB_CONTENT_NOT_CONFIGURED",
			"GitHub content publishing is not configured.",
			{ missing: name },
		);
	}
	return value;
}

function normalizeRoot(value: string, name: string): string {
	const normalized = value
		.trim()
		.replaceAll("\\", "/")
		.replace(/^\/+|\/+$/g, "");
	if (
		!normalized ||
		normalized.length > 240 ||
		normalized
			.split("/")
			.some((part) => !part || part === "." || part === "..")
	) {
		throw new ContentApiError(
			503,
			"GITHUB_CONTENT_NOT_CONFIGURED",
			"GitHub content publishing path is invalid.",
			{ field: name },
		);
	}
	return normalized;
}

function githubConfig(): GitHubConfig {
	const owner = configuredValue("GITHUB_CONTENT_OWNER");
	const repo = configuredValue("GITHUB_CONTENT_REPO");
	if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner)) {
		throw new ContentApiError(
			503,
			"GITHUB_CONTENT_NOT_CONFIGURED",
			"GitHub content owner is invalid.",
		);
	}
	if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
		throw new ContentApiError(
			503,
			"GITHUB_CONTENT_NOT_CONFIGURED",
			"GitHub content repository is invalid.",
		);
	}
	return {
		token: configuredValue("GITHUB_CONTENT_TOKEN"),
		owner,
		repo,
		branch: configuredValue("GITHUB_CONTENT_BRANCH", "main"),
		contentRoot: normalizeRoot(
			configuredValue("GITHUB_CONTENT_ROOT", "src/content/posts"),
			"GITHUB_CONTENT_ROOT",
		),
		trashRoot: normalizeRoot(
			configuredValue("GITHUB_CONTENT_TRASH_ROOT", ".trash/posts"),
			"GITHUB_CONTENT_TRASH_ROOT",
		),
	};
}

function repositoryPath(config: GitHubConfig): string {
	return `${config.owner}/${config.repo}`;
}

function encodePath(value: string): string {
	return value.split("/").map(encodeURIComponent).join("/");
}

async function githubRequest(
	config: GitHubConfig,
	method: string,
	path: string,
	body?: ContentJsonObject,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${GITHUB_API}${path}`, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${config.token}`,
				"Content-Type": "application/json",
				"User-Agent": "mizuki-blog-admin-api/1.0",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		throw new ContentApiError(
			503,
			"GITHUB_UNAVAILABLE",
			"GitHub content service is temporarily unavailable.",
		);
	}

	let payload: unknown = null;
	const responseType = response.headers.get("content-type") ?? "";
	if (responseType.includes("application/json")) {
		try {
			payload = await response.json();
		} catch {
			payload = null;
		}
	}
	if (response.ok) {
		return payload;
	}

	const requestId =
		response.headers.get("x-github-request-id")?.slice(0, 100) ?? undefined;
	const details: ContentJsonObject = {
		httpStatus: response.status,
		...(requestId ? { requestId } : {}),
	};
	if (response.status === 401 || response.status === 403) {
		throw new ContentApiError(
			503,
			"GITHUB_AUTH_FAILED",
			"GitHub content credentials are unavailable or insufficient.",
			details,
		);
	}
	if (response.status === 404) {
		throw new ContentApiError(
			404,
			"GITHUB_CONTENT_NOT_FOUND",
			"GitHub content resource was not found.",
			details,
		);
	}
	if (response.status === 409 || response.status === 422) {
		throw new ContentApiError(
			409,
			"GITHUB_CONTENT_CONFLICT",
			"GitHub rejected the content update because the repository changed.",
			details,
		);
	}
	throw new ContentApiError(
		503,
		"GITHUB_UNAVAILABLE",
		"GitHub content service returned an unexpected response.",
		details,
	);
}

function objectField(value: unknown, message: string): ContentJsonObject {
	if (!isObject(value)) {
		throw new ContentApiError(503, "GITHUB_INVALID_RESPONSE", message);
	}
	return value;
}

function responseString(
	value: unknown,
	field: string,
	message = "GitHub returned an invalid response.",
): string {
	if (typeof value !== "string" || !value) {
		throw new ContentApiError(503, "GITHUB_INVALID_RESPONSE", message, {
			field,
		});
	}
	return value;
}

async function readSnapshot(config: GitHubConfig): Promise<GitHubSnapshot> {
	const refPayload = objectField(
		await githubRequest(
			config,
			"GET",
			`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
				config.repo,
			)}/git/ref/heads/${encodePath(config.branch)}`,
		),
		"GitHub branch response is invalid.",
	);
	const refObject = objectField(
		refPayload.object,
		"GitHub branch response is invalid.",
	);
	const headSha = responseString(refObject.sha, "object.sha");

	const commitPayload = objectField(
		await githubRequest(
			config,
			"GET",
			`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
				config.repo,
			)}/git/commits/${encodeURIComponent(headSha)}`,
		),
		"GitHub commit response is invalid.",
	);
	const commitTree = objectField(
		commitPayload.tree,
		"GitHub commit response is invalid.",
	);
	const treeSha = responseString(commitTree.sha, "tree.sha");
	const treePayload = objectField(
		await githubRequest(
			config,
			"GET",
			`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
				config.repo,
			)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
		),
		"GitHub tree response is invalid.",
	);
	if (treePayload.truncated === true) {
		throw new ContentApiError(
			503,
			"GITHUB_TREE_TRUNCATED",
			"GitHub repository tree is too large for safe content editing.",
		);
	}
	if (!Array.isArray(treePayload.tree)) {
		throw new ContentApiError(
			503,
			"GITHUB_INVALID_RESPONSE",
			"GitHub tree response is invalid.",
		);
	}
	const entries: GitHubTreeEntry[] = [];
	for (const raw of treePayload.tree) {
		if (!isObject(raw)) {
			continue;
		}
		if (
			typeof raw.path !== "string" ||
			typeof raw.mode !== "string" ||
			typeof raw.sha !== "string" ||
			!["blob", "tree", "commit"].includes(String(raw.type))
		) {
			continue;
		}
		entries.push({
			path: raw.path,
			mode: raw.mode,
			type: raw.type as GitHubTreeEntry["type"],
			sha: raw.sha,
			size: typeof raw.size === "number" ? raw.size : undefined,
		});
	}
	return { headSha, treeSha, entries };
}

function isMarkdownPath(value: string): boolean {
	const lower = value.toLowerCase();
	return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function relativeFromRoot(path: string, root: string): string | null {
	const prefix = `${root}/`;
	if (!path.startsWith(prefix)) {
		return null;
	}
	const relative = path.slice(prefix.length);
	return relative && isMarkdownPath(relative) ? relative : null;
}

function decodeBase64Utf8(value: string): string {
	try {
		const normalized = value.replace(/\s+/g, "");
		const binary = atob(normalized);
		const bytes = Uint8Array.from(binary, (character) =>
			character.charCodeAt(0),
		);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ContentApiError(
			503,
			"GITHUB_INVALID_CONTENT",
			"GitHub returned invalid Markdown content.",
		);
	}
}

async function readBlob(
	config: GitHubConfig,
	entry: GitHubTreeEntry,
): Promise<string> {
	if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) {
		throw new ContentApiError(
			413,
			"CONTENT_FILE_TOO_LARGE",
			"A Markdown file is too large for the content editor.",
			{ path: entry.path, maxBytes: MAX_FILE_BYTES },
		);
	}
	const payload = objectField(
		await githubRequest(
			config,
			"GET",
			`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
				config.repo,
			)}/git/blobs/${encodeURIComponent(entry.sha)}`,
		),
		"GitHub blob response is invalid.",
	);
	if (payload.encoding !== "base64") {
		throw new ContentApiError(
			503,
			"GITHUB_INVALID_CONTENT",
			"GitHub returned unsupported Markdown encoding.",
			{ path: entry.path },
		);
	}
	return decodeBase64Utf8(responseString(payload.content, "content"));
}

function parseFrontmatter(
	source: string,
	path: string,
): { frontmatter: ContentJsonObject; body: string } {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
		source,
	);
	if (!match) {
		throw new ContentApiError(
			422,
			"CONTENT_FRONTMATTER_INVALID",
			"Markdown frontmatter is missing or invalid.",
			{ path },
		);
	}
	let value: unknown;
	try {
		value = parse(match[1]);
	} catch {
		throw new ContentApiError(
			422,
			"CONTENT_FRONTMATTER_INVALID",
			"Markdown frontmatter contains invalid YAML.",
			{ path },
		);
	}
	if (!isObject(value)) {
		throw new ContentApiError(
			422,
			"CONTENT_FRONTMATTER_INVALID",
			"Markdown frontmatter must be a YAML object.",
			{ path },
		);
	}
	return { frontmatter: value, body: source.slice(match[0].length) };
}

function scalarString(value: unknown, fallback = ""): string {
	if (typeof value === "string") {
		return value;
	}
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString();
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return fallback;
}

function scalarBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return [
		...new Set(
			value
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
}

function dateString(value: unknown, fallback: string): string {
	const source = scalarString(value);
	const date = new Date(source);
	return source && !Number.isNaN(date.getTime())
		? date.toISOString()
		: fallback;
}

function statusFromFrontmatter(
	frontmatter: ContentJsonObject,
	now = Date.now(),
): StudioPost["status"] {
	if (scalarBoolean(frontmatter.draft, false)) {
		return "draft";
	}
	const published = new Date(scalarString(frontmatter.published)).getTime();
	return Number.isFinite(published) && published > now
		? "scheduled"
		: "published";
}

function postFromSource(
	source: string,
	entry: GitHubTreeEntry,
	relativePath: string,
	inTrash: boolean,
): WorkingPost {
	const { frontmatter, body } = parseFrontmatter(source, entry.path);
	const now = new Date().toISOString();
	const publishedAt = dateString(frontmatter.published, now);
	const updatedAt = dateString(frontmatter.updated, publishedAt);
	const extension = MARKDOWN_EXTENSIONS.find((item) =>
		relativePath.toLowerCase().endsWith(item),
	);
	const slug = extension
		? relativePath.slice(0, -extension.length)
		: relativePath;
	const priority =
		typeof frontmatter.priority === "number" &&
		Number.isFinite(frontmatter.priority)
			? frontmatter.priority
			: null;
	const post: StudioPost = {
		id: relativePath,
		sha: entry.sha,
		title: scalarString(frontmatter.title),
		slug,
		description: scalarString(frontmatter.description),
		body,
		image: scalarString(frontmatter.image),
		tags: stringArray(frontmatter.tags),
		category: scalarString(frontmatter.category),
		kind: frontmatter.kind === "diary" ? "diary" : "article",
		status: inTrash ? "trash" : statusFromFrontmatter(frontmatter),
		hidden: scalarBoolean(frontmatter.hidden, false),
		pinned: scalarBoolean(frontmatter.pinned, false),
		priority,
		comment: scalarBoolean(frontmatter.comment, true),
		encrypted: scalarBoolean(frontmatter.encrypted, false),
		password: scalarString(frontmatter.password),
		passwordHint: scalarString(frontmatter.passwordHint),
		publishedAt,
		updatedAt,
		author: scalarString(frontmatter.author),
		lang: scalarString(frontmatter.lang),
		alias: scalarString(frontmatter.alias),
		permalink: scalarString(frontmatter.permalink),
		sourceLink: scalarString(frontmatter.sourceLink),
		licenseName: scalarString(frontmatter.licenseName),
		licenseUrl: scalarString(frontmatter.licenseUrl),
		...(inTrash
			? {
					trashPath: entry.path,
					trashedAt: dateString(frontmatter.trashedAt, updatedAt),
				}
			: {}),
	};
	return { post, fullPath: entry.path, frontmatter, source };
}

async function mapConcurrent<T, R>(
	values: T[],
	concurrency: number,
	mapper: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, values.length) },
		async () => {
			while (nextIndex < values.length) {
				const index = nextIndex;
				nextIndex += 1;
				results[index] = await mapper(values[index]);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

async function loadState(
	config: GitHubConfig,
	snapshot?: GitHubSnapshot,
): Promise<ContentState> {
	const currentSnapshot = snapshot ?? (await readSnapshot(config));
	const candidates = currentSnapshot.entries
		.filter((entry) => entry.type === "blob")
		.flatMap((entry) => {
			const activePath = relativeFromRoot(entry.path, config.contentRoot);
			if (activePath) {
				return [{ entry, relativePath: activePath, trash: false }];
			}
			const trashPath = relativeFromRoot(entry.path, config.trashRoot);
			return trashPath
				? [{ entry, relativePath: trashPath, trash: true }]
				: [];
		});
	if (candidates.length > MAX_POSTS) {
		throw new ContentApiError(
			413,
			"CONTENT_LIMIT_EXCEEDED",
			"The content repository has too many Markdown files for this editor.",
			{ maxPosts: MAX_POSTS },
		);
	}
	const working = await mapConcurrent(candidates, 6, async (candidate) => {
		const source = await readBlob(config, candidate.entry);
		return postFromSource(
			source,
			candidate.entry,
			candidate.relativePath,
			candidate.trash,
		);
	});
	const active = new Map<string, WorkingPost>();
	const trash = new Map<string, WorkingPost>();
	const originalSources = new Map<string, string>();
	for (const item of working) {
		const target = item.post.status === "trash" ? trash : active;
		if (target.has(item.post.id)) {
			throw new ContentApiError(
				409,
				"CONTENT_PATH_CONFLICT",
				"Duplicate Markdown paths were found in the content repository.",
				{ id: item.post.id },
			);
		}
		target.set(item.post.id, item);
		originalSources.set(item.fullPath, item.source);
	}
	return { snapshot: currentSnapshot, active, trash, originalSources };
}

function sortedPosts(state: ContentState): StudioPost[] {
	return [...state.active.values(), ...state.trash.values()]
		.map((item) => item.post)
		.sort((left, right) => {
			if (left.status === "trash" && right.status !== "trash") {
				return 1;
			}
			if (right.status === "trash" && left.status !== "trash") {
				return -1;
			}
			return (
				new Date(right.updatedAt).getTime() -
					new Date(left.updatedAt).getTime() ||
				left.id.localeCompare(right.id)
			);
		});
}

function revision(config: GitHubConfig, headSha: string): ContentJsonObject {
	return {
		headSha,
		branch: config.branch,
		repository: repositoryPath(config),
	};
}

function listResponse(
	config: GitHubConfig,
	state: ContentState,
): ContentJsonObject {
	return {
		posts: sortedPosts(state),
		revision: revision(config, state.snapshot.headSha),
		limits: {
			maxOperations: MAX_OPERATIONS,
			maxChangedFiles: MAX_CHANGED_FILES,
			maxFileBytes: MAX_FILE_BYTES,
		},
	};
}

function requestString(
	value: unknown,
	field: string,
	maxLength: number,
	options: { optional?: boolean; trim?: boolean } = {},
): string {
	if ((value === undefined || value === null) && options.optional) {
		return "";
	}
	if (typeof value !== "string") {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_FIELD",
			`${field} is invalid.`,
		);
	}
	const result = options.trim === false ? value : value.trim();
	if ((!result && !options.optional) || result.length > maxLength) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_FIELD",
			`${field} is invalid.`,
		);
	}
	return result;
}

function requestBoolean(
	value: unknown,
	field: string,
	fallback: boolean,
): boolean {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_FIELD",
			`${field} is invalid.`,
		);
	}
	return value;
}

function requestDate(value: unknown, field: string, fallback?: string): string {
	const source =
		typeof value === "string" && value.trim()
			? value.trim()
			: (fallback ?? "");
	const date = new Date(source);
	if (!source || Number.isNaN(date.getTime())) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_FIELD",
			`${field} is invalid.`,
		);
	}
	return date.toISOString();
}

function requestStringArray(
	value: unknown,
	field: string,
	maxItems = 50,
): string[] {
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_FIELD",
			`${field} is invalid.`,
		);
	}
	const result: string[] = [];
	for (const raw of value) {
		const item = requestString(raw, field, 80);
		if (!result.includes(item)) {
			result.push(item);
		}
	}
	return result;
}

function normalizeSlug(value: unknown): string {
	const slug = requestString(value, "post.slug", 240)
		.replaceAll("\\", "/")
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.(?:md|mdx)$/i, "");
	const segments = slug.split("/");
	if (
		!slug ||
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(segment),
		)
	) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_SLUG",
			"post.slug contains unsupported path characters.",
		);
	}
	return slug;
}

function normalizeId(value: unknown): string {
	const id = requestString(value, "id", 260).replaceAll("\\", "/");
	if (
		id.startsWith("/") ||
		!isMarkdownPath(id) ||
		id.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_ID",
			"Content id is invalid.",
		);
	}
	return id;
}

function expectedSha(operation: ContentJsonObject): string | null {
	if (
		operation.expectedSha === undefined ||
		operation.expectedSha === null ||
		operation.expectedSha === ""
	) {
		return null;
	}
	return requestString(operation.expectedSha, "expectedSha", 80);
}

function assertExpectedSha(
	item: WorkingPost,
	operation: ContentJsonObject,
): void {
	const expected = expectedSha(operation);
	if (expected && expected !== item.post.sha) {
		throw new ContentApiError(
			409,
			"CONTENT_FILE_CONFLICT",
			"The Markdown file changed since it was loaded.",
			{ id: item.post.id, currentSha: item.post.sha },
		);
	}
}

function normalizePost(raw: unknown, existing?: WorkingPost): StudioPost {
	if (!isObject(raw)) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_POST",
			"post must be an object.",
		);
	}
	const now = new Date().toISOString();
	const slug = normalizeSlug(raw.slug);
	const status = requestString(raw.status, "post.status", 20);
	if (!STATUS_VALUES.has(status)) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_STATUS",
			"post.status is invalid.",
		);
	}
	const kind = requestString(raw.kind ?? "article", "post.kind", 20);
	if (!KIND_VALUES.has(kind)) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_KIND",
			"post.kind is invalid.",
		);
	}
	const body = requestString(raw.body, "post.body", MAX_FILE_BYTES, {
		trim: false,
	});
	const encrypted = requestBoolean(raw.encrypted, "post.encrypted", false);
	const password = requestString(raw.password, "post.password", 200, {
		optional: true,
		trim: false,
	});
	if (encrypted && !password) {
		throw new ContentApiError(
			400,
			"CONTENT_PASSWORD_REQUIRED",
			"Encrypted posts require a password.",
		);
	}
	let priority: number | null = null;
	if (
		raw.priority !== undefined &&
		raw.priority !== null &&
		raw.priority !== ""
	) {
		if (
			typeof raw.priority !== "number" ||
			!Number.isInteger(raw.priority) ||
			raw.priority < -10_000 ||
			raw.priority > 10_000
		) {
			throw new ContentApiError(
				400,
				"INVALID_CONTENT_FIELD",
				"post.priority is invalid.",
			);
		}
		priority = raw.priority;
	}
	const publishedAt = requestDate(
		raw.publishedAt,
		"post.publishedAt",
		existing?.post.publishedAt ?? now,
	);
	return {
		id:
			typeof raw.id === "string" && raw.id.trim()
				? normalizeId(raw.id)
				: `${slug}.md`,
		sha: existing?.post.sha ?? "",
		title: requestString(raw.title, "post.title", 240),
		slug,
		description: requestString(raw.description, "post.description", 1000, {
			optional: true,
			trim: false,
		}),
		body,
		image: requestString(raw.image, "post.image", 1000, { optional: true }),
		tags: requestStringArray(raw.tags ?? [], "post.tags"),
		category: requestString(raw.category, "post.category", 80, {
			optional: true,
		}),
		kind: kind as StudioPost["kind"],
		status: status as StudioPost["status"],
		hidden: requestBoolean(raw.hidden, "post.hidden", false),
		pinned: requestBoolean(raw.pinned, "post.pinned", false),
		priority,
		comment: requestBoolean(raw.comment, "post.comment", true),
		encrypted,
		password,
		passwordHint: requestString(
			raw.passwordHint,
			"post.passwordHint",
			240,
			{ optional: true, trim: false },
		),
		publishedAt,
		updatedAt: now,
		author: requestString(raw.author, "post.author", 160, {
			optional: true,
		}),
		lang: requestString(raw.lang, "post.lang", 40, { optional: true }),
		alias: requestString(raw.alias, "post.alias", 240, { optional: true }),
		permalink: requestString(raw.permalink, "post.permalink", 500, {
			optional: true,
		}),
		sourceLink: requestString(raw.sourceLink, "post.sourceLink", 1000, {
			optional: true,
		}),
		licenseName: requestString(raw.licenseName, "post.licenseName", 160, {
			optional: true,
		}),
		licenseUrl: requestString(raw.licenseUrl, "post.licenseUrl", 1000, {
			optional: true,
		}),
	};
}

function setOrDelete(
	target: ContentJsonObject,
	key: string,
	value: unknown,
	emptyValue: unknown,
): void {
	if (
		value === emptyValue ||
		value === undefined ||
		value === null ||
		(Array.isArray(value) && value.length === 0)
	) {
		delete target[key];
	} else {
		target[key] = value;
	}
}

function sourceForPost(
	post: StudioPost,
	original: ContentJsonObject,
	options: { trashedAt?: string; restore?: boolean } = {},
): { source: string; frontmatter: ContentJsonObject } {
	const frontmatter: ContentJsonObject = { ...original };
	frontmatter.title = post.title;
	frontmatter.published = post.publishedAt;
	frontmatter.updated = post.updatedAt;
	frontmatter.draft = post.status === "draft";
	setOrDelete(frontmatter, "description", post.description, "");
	setOrDelete(frontmatter, "image", post.image, "");
	setOrDelete(frontmatter, "tags", post.tags, null);
	setOrDelete(frontmatter, "category", post.category, "");
	setOrDelete(frontmatter, "kind", post.kind, "article");
	setOrDelete(frontmatter, "lang", post.lang, "");
	setOrDelete(frontmatter, "pinned", post.pinned, false);
	setOrDelete(frontmatter, "hidden", post.hidden, false);
	setOrDelete(frontmatter, "comment", post.comment, true);
	setOrDelete(frontmatter, "priority", post.priority, null);
	setOrDelete(frontmatter, "author", post.author, "");
	setOrDelete(frontmatter, "sourceLink", post.sourceLink, "");
	setOrDelete(frontmatter, "licenseName", post.licenseName, "");
	setOrDelete(frontmatter, "licenseUrl", post.licenseUrl, "");
	setOrDelete(frontmatter, "encrypted", post.encrypted, false);
	if (post.encrypted) {
		frontmatter.password = post.password;
		setOrDelete(frontmatter, "passwordHint", post.passwordHint, "");
	} else {
		delete frontmatter.password;
		delete frontmatter.passwordHint;
	}
	setOrDelete(frontmatter, "alias", post.alias, "");
	setOrDelete(frontmatter, "permalink", post.permalink, "");
	if (options.trashedAt) {
		frontmatter.trashedAt = options.trashedAt;
	}
	if (options.restore) {
		delete frontmatter.trashedAt;
	}
	const yaml = stringify(frontmatter, { lineWidth: 0 }).trimEnd();
	const normalizedBody = post.body.replace(/^\r?\n/, "").replace(/\s*$/, "");
	const source = `---\n${yaml}\n---\n\n${normalizedBody}\n`;
	const sourceBytes = new TextEncoder().encode(source).byteLength;
	if (sourceBytes > MAX_FILE_BYTES) {
		throw new ContentApiError(
			413,
			"CONTENT_FILE_TOO_LARGE",
			"The Markdown file is too large for the content editor.",
			{ id: post.id, maxBytes: MAX_FILE_BYTES },
		);
	}
	return {
		frontmatter,
		source,
	};
}

function activePath(config: GitHubConfig, id: string): string {
	return `${config.contentRoot}/${id}`;
}

function trashPath(config: GitHubConfig, id: string): string {
	return `${config.trashRoot}/${id}`;
}

function markTouched(touched: Set<string>, ...paths: string[]): void {
	for (const path of paths) {
		touched.add(path);
	}
	if (touched.size > MAX_CHANGED_FILES) {
		throw new ContentApiError(
			413,
			"CONTENT_CHANGE_LIMIT_EXCEEDED",
			"Too many Markdown files would be changed in one commit.",
			{ maxChangedFiles: MAX_CHANGED_FILES },
		);
	}
}

function normalizedRouteKey(value: string): string {
	return value
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/+/g, "/")
		.toLowerCase();
}

function postRouteKeys(post: StudioPost): string[] {
	const keys = new Set<string>([normalizedRouteKey(`posts/${post.slug}`)]);
	if (post.permalink) {
		keys.add(normalizedRouteKey(post.permalink));
	} else if (post.alias) {
		const alias = normalizedRouteKey(post.alias).replace(/^posts\//, "");
		keys.add(normalizedRouteKey(`posts/${alias}`));
	}
	return [...keys].filter(Boolean);
}

function assertUniqueActiveRoutes(state: ContentState): void {
	const owners = new Map<string, string>();
	for (const item of state.active.values()) {
		for (const route of postRouteKeys(item.post)) {
			const existingId = owners.get(route);
			if (existingId && existingId !== item.post.id) {
				throw new ContentApiError(
					409,
					"CONTENT_ROUTE_CONFLICT",
					"Two active posts would generate the same public route.",
					{
						route: `/${route}/`,
						ids: [existingId, item.post.id],
					},
				);
			}
			owners.set(route, item.post.id);
		}
	}
}

function saveOperation(
	config: GitHubConfig,
	state: ContentState,
	operation: ContentJsonObject,
	touched: Set<string>,
): void {
	if (!isObject(operation.post)) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_POST",
			"save operation requires post.",
		);
	}
	const rawId =
		typeof operation.post.id === "string" && operation.post.id.trim()
			? normalizeId(operation.post.id)
			: null;
	const existing = rawId ? state.active.get(rawId) : undefined;
	if (rawId && !existing && state.trash.has(rawId)) {
		throw new ContentApiError(
			409,
			"CONTENT_IN_TRASH",
			"Restore the trashed post before editing it.",
			{ id: rawId },
		);
	}
	if (existing) {
		assertExpectedSha(existing, operation);
	}
	if (!existing && expectedSha(operation)) {
		throw new ContentApiError(
			409,
			"CONTENT_FILE_CONFLICT",
			"The Markdown file no longer exists at the expected path.",
			{ id: rawId },
		);
	}
	const post = normalizePost(operation.post, existing);
	const targetId = `${post.slug}.md`;
	const collision = state.active.get(targetId);
	if (collision && collision !== existing) {
		throw new ContentApiError(
			409,
			"CONTENT_PATH_CONFLICT",
			"Another post already uses this slug.",
			{ id: targetId },
		);
	}
	if (state.trash.has(targetId)) {
		throw new ContentApiError(
			409,
			"CONTENT_PATH_CONFLICT",
			"A trashed post already uses this slug.",
			{ id: targetId },
		);
	}
	post.id = targetId;
	const generated = sourceForPost(post, existing?.frontmatter ?? {});
	const next: WorkingPost = {
		post,
		fullPath: activePath(config, targetId),
		frontmatter: generated.frontmatter,
		source: generated.source,
	};
	if (existing) {
		state.active.delete(existing.post.id);
		markTouched(touched, existing.fullPath);
	}
	state.active.set(targetId, next);
	markTouched(touched, next.fullPath);
}

function trashOperation(
	config: GitHubConfig,
	state: ContentState,
	operation: ContentJsonObject,
	touched: Set<string>,
): void {
	const id = normalizeId(operation.id);
	const existing = state.active.get(id);
	if (!existing) {
		throw new ContentApiError(
			404,
			"CONTENT_NOT_FOUND",
			"The post to trash was not found.",
			{ id },
		);
	}
	assertExpectedSha(existing, operation);
	if (state.trash.has(id)) {
		throw new ContentApiError(
			409,
			"CONTENT_PATH_CONFLICT",
			"The trash already contains a post at this path.",
			{ id },
		);
	}
	const trashedAt = new Date().toISOString();
	const post: StudioPost = {
		...existing.post,
		status: "trash",
		updatedAt: trashedAt,
		trashPath: trashPath(config, id),
		trashedAt,
	};
	const generated = sourceForPost(
		{ ...post, status: existing.post.status },
		existing.frontmatter,
		{ trashedAt },
	);
	const next: WorkingPost = {
		post,
		fullPath: trashPath(config, id),
		frontmatter: generated.frontmatter,
		source: generated.source,
	};
	state.active.delete(id);
	state.trash.set(id, next);
	markTouched(touched, existing.fullPath, next.fullPath);
}

function restoreOperation(
	config: GitHubConfig,
	state: ContentState,
	operation: ContentJsonObject,
	touched: Set<string>,
): void {
	const id = normalizeId(operation.id);
	const existing = state.trash.get(id);
	if (!existing) {
		throw new ContentApiError(
			404,
			"CONTENT_NOT_FOUND",
			"The post to restore was not found.",
			{ id },
		);
	}
	assertExpectedSha(existing, operation);
	const slug =
		operation.slug === undefined || operation.slug === null
			? existing.post.slug
			: normalizeSlug(operation.slug);
	const targetId = `${slug}.md`;
	if (state.active.has(targetId)) {
		throw new ContentApiError(
			409,
			"CONTENT_PATH_CONFLICT",
			"An active post already uses the restore path.",
			{ id: targetId },
		);
	}
	const post: StudioPost = {
		...existing.post,
		id: targetId,
		slug,
		status: "draft",
		hidden: false,
		updatedAt: new Date().toISOString(),
	};
	delete post.trashPath;
	delete post.trashedAt;
	const generated = sourceForPost(post, existing.frontmatter, {
		restore: true,
	});
	const next: WorkingPost = {
		post,
		fullPath: activePath(config, targetId),
		frontmatter: generated.frontmatter,
		source: generated.source,
	};
	state.trash.delete(id);
	state.active.set(targetId, next);
	markTouched(touched, existing.fullPath, next.fullPath);
}

function deleteOperation(
	state: ContentState,
	operation: ContentJsonObject,
	touched: Set<string>,
	initialTrashIds: ReadonlySet<string>,
): void {
	if (operation.confirm !== true) {
		throw new ContentApiError(
			400,
			"CONTENT_DELETE_CONFIRMATION_REQUIRED",
			"Permanent deletion requires confirm: true.",
		);
	}
	const id = normalizeId(operation.id);
	if (!initialTrashIds.has(id)) {
		throw new ContentApiError(
			409,
			"CONTENT_DELETE_REQUIRES_PRIOR_TRASH_COMMIT",
			"Move the post to trash in a separate commit before permanently deleting it.",
			{ id },
		);
	}
	const existing = state.trash.get(id);
	if (!existing) {
		throw new ContentApiError(
			404,
			"CONTENT_NOT_FOUND",
			"Only a post in the trash can be permanently deleted.",
			{ id },
		);
	}
	assertExpectedSha(existing, operation);
	state.trash.delete(id);
	markTouched(touched, existing.fullPath);
}

function taxonomyOperation(
	config: GitHubConfig,
	state: ContentState,
	operation: ContentJsonObject,
	touched: Set<string>,
): void {
	const taxonomy = requestString(operation.taxonomy, "taxonomy", 20);
	if (taxonomy !== "category" && taxonomy !== "tag") {
		throw new ContentApiError(
			400,
			"INVALID_TAXONOMY",
			"taxonomy must be category or tag.",
		);
	}
	const mode = requestString(operation.mode, "mode", 20);
	if (!["rename", "merge", "delete"].includes(mode)) {
		throw new ContentApiError(
			400,
			"INVALID_TAXONOMY_OPERATION",
			"taxonomy mode is invalid.",
		);
	}
	const from = requestString(operation.from, "from", 80);
	const to = mode === "delete" ? "" : requestString(operation.to, "to", 80);
	if (from === "未分类" && taxonomy === "category") {
		throw new ContentApiError(
			400,
			"SYSTEM_TAXONOMY_PROTECTED",
			"The uncategorized system item cannot be renamed or deleted.",
		);
	}
	if (mode !== "delete" && from === to) {
		return;
	}
	const now = new Date().toISOString();
	for (const [id, item] of state.active) {
		let changed = false;
		const post: StudioPost = { ...item.post, tags: [...item.post.tags] };
		if (taxonomy === "category" && post.category === from) {
			post.category = mode === "delete" ? "" : to;
			changed = true;
		}
		if (taxonomy === "tag" && post.tags.includes(from)) {
			post.tags = [
				...new Set(
					post.tags
						.map((tag) => (tag === from ? to : tag))
						.filter(Boolean),
				),
			];
			changed = true;
		}
		if (!changed) {
			continue;
		}
		post.updatedAt = now;
		const generated = sourceForPost(post, item.frontmatter);
		state.active.set(id, {
			...item,
			post,
			frontmatter: generated.frontmatter,
			source: generated.source,
		});
		markTouched(touched, activePath(config, id));
	}
}

function finalSourceByPath(state: ContentState): Map<string, string> {
	const result = new Map<string, string>();
	for (const item of [...state.active.values(), ...state.trash.values()]) {
		result.set(item.fullPath, item.source);
	}
	return result;
}

async function createBlob(
	config: GitHubConfig,
	source: string,
): Promise<string> {
	const payload = objectField(
		await githubRequest(
			config,
			"POST",
			`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
				config.repo,
			)}/git/blobs`,
			{ content: source, encoding: "utf-8" },
		),
		"GitHub blob creation response is invalid.",
	);
	return responseString(payload.sha, "sha");
}

async function commitChanges(
	config: GitHubConfig,
	state: ContentState,
	touched: Set<string>,
	message: string,
): Promise<{ sha: string; url: string | null } | null> {
	const finalSources = finalSourceByPath(state);
	const effective = [...touched].filter((path) => {
		const before = state.originalSources.get(path);
		const after = finalSources.get(path);
		return before !== after;
	});
	if (effective.length === 0) {
		return null;
	}
	const blobs = await mapConcurrent(effective, 5, async (path) => {
		const source = finalSources.get(path);
		return {
			path,
			sha: source === undefined ? null : await createBlob(config, source),
		};
	});
	const changes: TreeChange[] = blobs.map((item) => ({
		path: item.path,
		mode: "100644",
		type: "blob",
		sha: item.sha,
	}));
	const treePayload = objectField(
		await githubRequest(
			config,
			"POST",
			`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
				config.repo,
			)}/git/trees`,
			{
				base_tree: state.snapshot.treeSha,
				tree: changes,
			},
		),
		"GitHub tree creation response is invalid.",
	);
	const treeSha = responseString(treePayload.sha, "sha");
	const commitPayload = objectField(
		await githubRequest(
			config,
			"POST",
			`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
				config.repo,
			)}/git/commits`,
			{
				message,
				tree: treeSha,
				parents: [state.snapshot.headSha],
			},
		),
		"GitHub commit creation response is invalid.",
	);
	const commitSha = responseString(commitPayload.sha, "sha");
	await githubRequest(
		config,
		"PATCH",
		`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
			config.repo,
		)}/git/refs/heads/${encodePath(config.branch)}`,
		{ sha: commitSha, force: false },
	);
	return {
		sha: commitSha,
		url:
			typeof commitPayload.html_url === "string"
				? commitPayload.html_url
				: null,
	};
}

async function recordAudit(
	actor: ContentActor,
	commit: { sha: string; url: string | null },
	operations: ContentJsonObject[],
): Promise<void> {
	try {
		const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
		const serviceKey =
			Deno.env.get("SUPABASE_SECRET_KEY") ??
			secretFromMap(Deno.env.get("SUPABASE_SECRET_KEYS")) ??
			Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
		if (!supabaseUrl || !serviceKey) {
			return;
		}
		const response = await fetch(`${supabaseUrl}/rest/v1/admin_audit_log`, {
			method: "POST",
			headers: {
				apikey: serviceKey,
				Authorization: `Bearer ${serviceKey}`,
				"Content-Type": "application/json",
				Prefer: "return=minimal",
			},
			body: JSON.stringify({
				actor_user_id: actor.userId,
				actor_provider: "github",
				actor_provider_id: actor.githubId,
				action: "content.commit",
				target_type: "git_commit",
				target_id: commit.sha,
				new_status: "committed",
				details: {
					commitUrl: commit.url,
					operationCount: operations.length,
					operations: operations.map((operation) =>
						typeof operation.op === "string"
							? operation.op
							: "unknown",
					),
				},
				request_id: crypto.randomUUID(),
			}),
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) {
			// eslint-disable-next-line no-console
			console.warn("[blog-admin-api] content audit write failed");
		}
	} catch {
		// eslint-disable-next-line no-console
		console.warn("[blog-admin-api] content audit write failed");
	}
}

export async function contentListAction(): Promise<ContentJsonObject> {
	const config = githubConfig();
	return listResponse(config, await loadState(config));
}

export async function contentGetAction(
	body: ContentJsonObject,
): Promise<ContentJsonObject> {
	const config = githubConfig();
	const id = normalizeId(body.id);
	const state = await loadState(config);
	const item = state.active.get(id) ?? state.trash.get(id);
	if (!item) {
		throw new ContentApiError(
			404,
			"CONTENT_NOT_FOUND",
			"The requested post was not found.",
			{ id },
		);
	}
	return {
		post: item.post,
		revision: revision(config, state.snapshot.headSha),
	};
}

export async function contentCommitAction(
	body: ContentJsonObject,
	actor: ContentActor,
): Promise<ContentJsonObject> {
	const config = githubConfig();
	const baseHeadSha = requestString(body.baseHeadSha, "baseHeadSha", 80);
	if (!Array.isArray(body.operations)) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_OPERATIONS",
			"operations must be an array.",
		);
	}
	if (
		body.operations.length === 0 ||
		body.operations.length > MAX_OPERATIONS
	) {
		throw new ContentApiError(
			400,
			"INVALID_CONTENT_OPERATIONS",
			"operations count is invalid.",
			{ maxOperations: MAX_OPERATIONS },
		);
	}
	const operations = body.operations.map((operation) => {
		if (!isObject(operation)) {
			throw new ContentApiError(
				400,
				"INVALID_CONTENT_OPERATION",
				"Each content operation must be an object.",
			);
		}
		return operation;
	});
	const snapshot = await readSnapshot(config);
	if (snapshot.headSha !== baseHeadSha) {
		throw new ContentApiError(
			409,
			"CONTENT_REVISION_CONFLICT",
			"The content repository changed. Refresh before saving.",
			{ currentHeadSha: snapshot.headSha },
		);
	}
	const state = await loadState(config, snapshot);
	const initialTrashIds = new Set(state.trash.keys());
	const touched = new Set<string>();
	for (const operation of operations) {
		const op = requestString(operation.op, "op", 20);
		switch (op) {
			case "save":
				saveOperation(config, state, operation, touched);
				break;
			case "trash":
				trashOperation(config, state, operation, touched);
				break;
			case "restore":
				restoreOperation(config, state, operation, touched);
				break;
			case "delete":
				deleteOperation(state, operation, touched, initialTrashIds);
				break;
			case "taxonomy":
				taxonomyOperation(config, state, operation, touched);
				break;
			default:
				throw new ContentApiError(
					400,
					"INVALID_CONTENT_OPERATION",
					"Unsupported content operation.",
					{ op },
				);
		}
	}
	assertUniqueActiveRoutes(state);
	const rawMessage = requestString(body.message, "message", 120, {
		optional: true,
	});
	const commitMessage = rawMessage
		? `[blog-admin] ${rawMessage}`
		: `[blog-admin] update ${operations.length} content operation${
				operations.length === 1 ? "" : "s"
			}`;
	const commit = await commitChanges(
		config,
		state,
		touched,
		commitMessage.slice(0, 180),
	);
	if (!commit) {
		return {
			commit: null,
			...listResponse(config, state),
		};
	}
	await recordAudit(actor, commit, operations);
	const nextSnapshot = await readSnapshot(config);
	if (nextSnapshot.headSha !== commit.sha) {
		throw new ContentApiError(
			409,
			"CONTENT_REVISION_CONFLICT",
			"The content commit succeeded, but the branch changed again. Refresh.",
			{
				committedHeadSha: commit.sha,
				currentHeadSha: nextSnapshot.headSha,
			},
		);
	}
	const nextState = await loadState(config, nextSnapshot);
	return {
		commit,
		...listResponse(config, nextState),
	};
}
