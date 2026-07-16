import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const rootDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const postsDir = path.join(rootDir, "src", "content", "posts");
const diaryPath = path.join(rootDir, "src", "data", "diary.json");
const publicDir = path.join(rootDir, "public");
const bucketName = "blog-media";
const dryRun = process.argv.includes("--dry-run");

const mimeTypes = new Map([
	[".avif", "image/avif"],
	[".gif", "image/gif"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".webp", "image/webp"],
]);

async function loadLocalEnv() {
	const envPath = path.join(rootDir, ".env");
	let source;
	try {
		source = await fs.readFile(envPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}

	for (const rawLine of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator < 1) continue;
		const name = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (!process.env[name]) process.env[name] = value;
	}
}

function requireEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`缺少环境变量 ${name}`);
	return value;
}

function redact(value) {
	let output = String(value ?? "");
	for (const name of ["SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY"]) {
		const secret = process.env[name];
		if (secret) output = output.replaceAll(secret, "[REDACTED]");
	}
	return output.replace(
		/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g,
		"[REDACTED]",
	);
}

async function walkMarkdown(directory) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await walkMarkdown(fullPath)));
		else if (entry.isFile() && /\.md$/i.test(entry.name))
			files.push(fullPath);
	}
	return files;
}

function parsePost(filePath, source) {
	const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
	if (!match)
		throw new Error(`${path.relative(rootDir, filePath)} 缺少 Frontmatter`);
	const data = parseYaml(match[1]) ?? {};
	const body = source.slice(match[0].length);
	return { data, body };
}

function normalizePostKey(filePath) {
	const key = path
		.relative(postsDir, filePath)
		.replaceAll(path.sep, "/")
		.replace(/\.md$/i, "");
	return key.endsWith("/index") ? key.slice(0, -"/index".length) : key;
}

function normalizeCanonicalPath(postKey, data) {
	if (data.permalink) {
		const permalink = String(data.permalink).replace(/^\/+|\/+$/g, "");
		return `/${permalink}`;
	}
	if (data.alias) {
		const alias = String(data.alias)
			.replace(/^\/+|\/+$/g, "")
			.replace(/^posts\//, "");
		return `/posts/${alias}`;
	}
	return `/posts/${postKey}`;
}

function normalizeTags(tags) {
	if (Array.isArray(tags))
		return tags
			.map(String)
			.map((tag) => tag.trim())
			.filter(Boolean);
	if (typeof tags === "string") {
		return tags
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);
	}
	return [];
}

function cleanMediaReference(reference) {
	const raw = String(reference ?? "")
		.trim()
		.replace(/^<|>$/g, "");
	if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw)) return null;
	if (/^(?:[a-z]:[\\/]|\\\\)/i.test(raw)) return null;
	const withoutSuffix = raw.split(/[?#]/, 1)[0];
	try {
		return decodeURIComponent(withoutSuffix);
	} catch {
		return withoutSuffix;
	}
}

function collectMediaReferences(data, body) {
	const references = new Set();
	if (data.image) references.add(String(data.image));
	const searchableBody = body
		.replace(/^(```|~~~)[^\r\n]*\r?\n[\s\S]*?^\1[^\r\n]*$/gm, "")
		.replace(/^(?: {4}|\t).*$/gm, "")
		.replace(/`[^`\r\n]*`/g, "");
	for (const match of searchableBody.matchAll(
		/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g,
	)) {
		references.add(match[1]);
	}
	for (const match of searchableBody.matchAll(
		/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
	)) {
		references.add(match[1]);
	}
	return [...references];
}

function resolveMediaPath(postFile, reference) {
	const cleaned = cleanMediaReference(reference);
	if (!cleaned) return null;
	const resolved = cleaned.startsWith("/")
		? path.join(publicDir, cleaned.replace(/^\/+/, ""))
		: path.resolve(path.dirname(postFile), cleaned);
	const relative = path.relative(rootDir, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return resolved;
}

function safeObjectSegment(value) {
	return (
		value
			.normalize("NFKD")
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "asset"
	);
}

async function request(url, options, acceptedStatuses = [200, 201, 204]) {
	const response = await fetch(url, options);
	if (!acceptedStatuses.includes(response.status)) {
		const body = await response.text();
		throw new Error(
			`Supabase HTTP ${response.status}: ${redact(body).slice(0, 500)}`,
		);
	}
	return response;
}

async function uploadMedia({
	supabaseUrl,
	secretKey,
	postKey,
	filePath,
	dryRun,
}) {
	const bytes = await fs.readFile(filePath);
	const hash = crypto
		.createHash("sha256")
		.update(bytes)
		.digest("hex")
		.slice(0, 12);
	const fileName = `${hash}-${safeObjectSegment(path.basename(filePath))}`;
	const objectPath = `posts/${postKey.split("/").map(safeObjectSegment).join("/")}/${fileName}`;
	if (dryRun) return objectPath;

	const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
	await request(
		`${supabaseUrl}/storage/v1/object/${bucketName}/${encodedPath}`,
		{
			method: "POST",
			headers: {
				apikey: secretKey,
				"Content-Type":
					mimeTypes.get(path.extname(filePath).toLowerCase()) ??
					"application/octet-stream",
				"User-Agent": "mizuki-supabase-content-sync/1.0",
				"x-upsert": "true",
			},
			body: bytes,
		},
	);
	return objectPath;
}

await loadLocalEnv();
const supabaseUrl = dryRun
	? ""
	: requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const secretKey = dryRun ? "" : requireEnv("SUPABASE_SECRET_KEY");
const postFiles = await walkMarkdown(postsDir);
const records = [];
let uploadedMediaCount = 0;

for (const filePath of postFiles) {
	const source = await fs.readFile(filePath, "utf8");
	const { data, body } = parsePost(filePath, source);
	const postKey = normalizePostKey(filePath);
	const encrypted = data.encrypted === true;
	const media = [];

	for (const reference of collectMediaReferences(
		data,
		encrypted ? "" : body,
	)) {
		const mediaPath = resolveMediaPath(filePath, reference);
		if (!mediaPath) continue;
		try {
			const objectPath = await uploadMedia({
				supabaseUrl,
				secretKey,
				postKey,
				filePath: mediaPath,
				dryRun,
			});
			media.push({ reference, object_path: objectPath });
			uploadedMediaCount += 1;
		} catch (error) {
			if (error?.code === "ENOENT") {
				throw new Error(
					`${path.relative(rootDir, filePath)} 引用的图片不存在：${reference}`,
				);
			}
			throw error;
		}
	}

	const cover = media.find(
		(item) => item.reference === String(data.image ?? ""),
	);
	const publishedAt = new Date(data.published);
	if (!data.title || Number.isNaN(publishedAt.getTime())) {
		throw new Error(
			`${path.relative(rootDir, filePath)} 的 title 或 published 无效`,
		);
	}
	records.push({
		post_key: postKey,
		kind: data.kind === "diary" ? "diary" : "article",
		canonical_path: normalizeCanonicalPath(postKey, data),
		title: String(data.title),
		summary: data.description ? String(data.description) : "",
		body_markdown: encrypted ? "" : body.trimStart(),
		cover_object_path: cover?.object_path ?? null,
		tags: normalizeTags(data.tags),
		category: data.category ? String(data.category) : null,
		status:
			data.trashed === true
				? "archived"
				: data.draft === true
					? "draft"
					: "published",
		comment_enabled: data.comment !== false,
		published_at: publishedAt.toISOString(),
		metadata: {
			source_file: path
				.relative(rootDir, filePath)
				.replaceAll(path.sep, "/"),
			encrypted,
			hidden: data.hidden === true,
			trashed: data.trashed === true,
			pinned: data.pinned === true,
			priority:
				typeof data.priority === "number" &&
				Number.isFinite(data.priority)
					? data.priority
					: null,
			media,
		},
	});
}

const diaryItems = JSON.parse(await fs.readFile(diaryPath, "utf8"));
if (!Array.isArray(diaryItems)) {
	throw new Error(`${path.relative(rootDir, diaryPath)} 必须是 JSON 数组`);
}

for (const item of diaryItems) {
	if (!item || typeof item !== "object") {
		throw new Error(
			`${path.relative(rootDir, diaryPath)} 包含无效日记条目`,
		);
	}
	const id = String(item.id ?? "").trim();
	const content = String(item.content ?? "").trim();
	const publishedAt = new Date(item.date);
	if (!id || !content || Number.isNaN(publishedAt.getTime())) {
		throw new Error(
			`${path.relative(rootDir, diaryPath)} 的 id、content 或 date 无效`,
		);
	}

	const postKey = `diary/${id}`;
	const media = [];
	const images = Array.isArray(item.images) ? item.images.map(String) : [];
	for (const reference of images) {
		const mediaPath = resolveMediaPath(diaryPath, reference);
		if (!mediaPath) continue;
		try {
			const objectPath = await uploadMedia({
				supabaseUrl,
				secretKey,
				postKey,
				filePath: mediaPath,
				dryRun,
			});
			media.push({ reference, object_path: objectPath });
			uploadedMediaCount += 1;
		} catch (error) {
			if (error?.code === "ENOENT") {
				throw new Error(
					`${path.relative(rootDir, diaryPath)} 引用的图片不存在：${reference}`,
				);
			}
			throw error;
		}
	}

	records.push({
		post_key: postKey,
		kind: "diary",
		canonical_path: `/diary/${encodeURIComponent(id)}`,
		title: item.title ? String(item.title) : `日记 #${id}`,
		summary: content.slice(0, 1000),
		body_markdown: content,
		cover_object_path: media[0]?.object_path ?? null,
		tags: normalizeTags(item.tags),
		category: "日记",
		status: item.draft === true ? "draft" : "published",
		comment_enabled: item.comment !== false,
		published_at: publishedAt.toISOString(),
		metadata: {
			source_file: path
				.relative(rootDir, diaryPath)
				.replaceAll(path.sep, "/"),
			diary_id: item.id,
			hidden: false,
			trashed: false,
			pinned: false,
			priority: null,
			location: item.location ? String(item.location) : null,
			mood: item.mood ? String(item.mood) : null,
			media,
		},
	});
}

if (!dryRun) {
	await request(
		`${supabaseUrl}/rest/v1/content_entries?on_conflict=post_key`,
		{
			method: "POST",
			headers: {
				apikey: secretKey,
				"Content-Type": "application/json",
				Prefer: "resolution=merge-duplicates,return=minimal",
				"User-Agent": "mizuki-supabase-content-sync/1.0",
			},
			body: JSON.stringify(records),
		},
	);

	const existingResponse = await request(
		`${supabaseUrl}/rest/v1/content_entries?select=post_key,status,metadata&limit=10000`,
		{
			method: "GET",
			headers: {
				apikey: secretKey,
				Accept: "application/json",
				"User-Agent": "mizuki-supabase-content-sync/1.0",
			},
		},
	);
	const existingRecords = await existingResponse.json();
	const currentKeys = new Set(records.map((record) => record.post_key));
	const missingKeys = Array.isArray(existingRecords)
		? existingRecords
				.filter((record) => {
					const sourceFile = record?.metadata?.source_file;
					const managed =
						typeof sourceFile === "string" &&
						(sourceFile.startsWith("src/content/posts/") ||
							sourceFile === "src/data/diary.json");
					return (
						managed &&
						record.status !== "archived" &&
						typeof record.post_key === "string" &&
						!currentKeys.has(record.post_key)
					);
				})
				.map((record) => record.post_key)
		: [];

	for (const postKey of missingKeys) {
		await request(
			`${supabaseUrl}/rest/v1/content_entries?post_key=eq.${encodeURIComponent(
				postKey,
			)}`,
			{
				method: "PATCH",
				headers: {
					apikey: secretKey,
					"Content-Type": "application/json",
					Prefer: "return=minimal",
					"User-Agent": "mizuki-supabase-content-sync/1.0",
				},
				body: JSON.stringify({ status: "archived" }),
			},
		);
	}
}

console.log(
	`Supabase 内容同步${dryRun ? "预检" : ""}完成：${records.length} 篇文章/日志，${uploadedMediaCount} 个媒体文件。`,
);
