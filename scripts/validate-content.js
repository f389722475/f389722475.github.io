import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const postsDir = path.join(rootDir, "src", "content", "posts");
const publicDir = path.join(rootDir, "public");
const imageExtensions = new Set([
	".avif",
	".gif",
	".jpeg",
	".jpg",
	".png",
	".svg",
	".webp",
]);

const errors = [];
const warnings = [];

function walkFiles(directory) {
	if (!fs.existsSync(directory)) return [];

	return fs
		.readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			const fullPath = path.join(directory, entry.name);
			return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
		});
}

function relativeToRoot(filePath) {
	return path.relative(rootDir, filePath).replaceAll(path.sep, "/");
}

function readFrontmatter(filePath, source) {
	const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
	if (!match) {
		errors.push(
			`${relativeToRoot(filePath)}：缺少有效的 YAML Frontmatter。`,
		);
		return null;
	}

	return match[1];
}

function readScalar(frontmatter, key) {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"));
	if (!match) return undefined;

	let value = match[1].trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1).trim();
	}

	value = value.replace(/\s+#.*$/, "").trim();
	return value;
}

function isRemoteOrGeneratedReference(reference) {
	return (
		/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference) ||
		/[{}]/.test(reference)
	);
}

function cleanReference(reference) {
	let cleaned = reference.trim().replace(/^<|>$/g, "");
	cleaned = cleaned.split(/[?#]/, 1)[0];
	try {
		return decodeURIComponent(cleaned);
	} catch {
		return cleaned;
	}
}

function validateLocalImage(filePath, rawReference, location) {
	const reference = cleanReference(rawReference);
	if (/^(?:file:|[a-z]:[\\/]|\\\\)/i.test(reference)) {
		errors.push(
			`${relativeToRoot(filePath)}：${location}不能使用电脑绝对路径：${rawReference}`,
		);
		return;
	}
	if (!reference || isRemoteOrGeneratedReference(reference)) return;

	const resolvedPath = reference.startsWith("/")
		? path.join(publicDir, reference.replace(/^\/+/, ""))
		: path.resolve(path.dirname(filePath), reference);
	const relativePath = path.relative(rootDir, resolvedPath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		errors.push(
			`${relativeToRoot(filePath)}：${location}必须保存在项目目录内：${rawReference}`,
		);
		return;
	}

	if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
		errors.push(
			`${relativeToRoot(filePath)}：${location}引用的图片不存在：${rawReference}`,
		);
	}
}

function validatePost(filePath) {
	const source = fs.readFileSync(filePath, "utf8");
	const frontmatter = readFrontmatter(filePath, source);
	if (frontmatter === null) return;

	const title = readScalar(frontmatter, "title");
	const published = readScalar(frontmatter, "published");
	const updated = readScalar(frontmatter, "updated");
	const draft = readScalar(frontmatter, "draft");
	const hidden = readScalar(frontmatter, "hidden");
	const trashed = readScalar(frontmatter, "trashed");
	const image = readScalar(frontmatter, "image");

	if (!title) {
		errors.push(`${relativeToRoot(filePath)}：title 不能为空。`);
	}

	if (!published) {
		errors.push(`${relativeToRoot(filePath)}：缺少 published。`);
	} else if (Number.isNaN(Date.parse(published))) {
		errors.push(
			`${relativeToRoot(filePath)}：published 不是有效日期：${published}`,
		);
	}

	if (updated && Number.isNaN(Date.parse(updated))) {
		errors.push(
			`${relativeToRoot(filePath)}：updated 不是有效日期：${updated}`,
		);
	}

	for (const [field, value] of Object.entries({
		draft,
		hidden,
		trashed,
	})) {
		if (value !== undefined && !/^(?:true|false)$/i.test(value)) {
			errors.push(
				`${relativeToRoot(filePath)}：${field} 只能是 true 或 false。`,
			);
		}
	}

	if (image) validateLocalImage(filePath, image, "Frontmatter image ");

	// 忽略代码块和行内代码，避免把教程中的 Markdown 示例当成真实图片。
	const body = source
		.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, "")
		.replace(/^(?: {4}|\t).*$/gm, "")
		.replace(/`[^`\r\n]*`/g, "");
	const markdownImagePattern =
		/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
	for (const match of body.matchAll(markdownImagePattern)) {
		validateLocalImage(filePath, match[1], "正文 ");
	}

	const htmlImagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
	for (const match of body.matchAll(htmlImagePattern)) {
		validateLocalImage(filePath, match[1], "HTML img ");
	}
}

if (!fs.existsSync(postsDir)) {
	console.error("内容检查失败：找不到 src/content/posts 目录。");
	process.exit(1);
}

const allFiles = walkFiles(postsDir);
const postFiles = allFiles.filter(
	(filePath) => path.extname(filePath) === ".md",
);
const imageFiles = allFiles.filter((filePath) =>
	imageExtensions.has(path.extname(filePath).toLowerCase()),
);

if (postFiles.length === 0) {
	warnings.push("src/content/posts 中没有 Markdown 文章。");
}

for (const filePath of postFiles) validatePost(filePath);

for (const warning of warnings) console.warn(`警告：${warning}`);

if (errors.length > 0) {
	console.error(`内容检查失败，共发现 ${errors.length} 个问题：`);
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

console.log(
	`内容检查通过：${postFiles.length} 篇 Markdown 文章，${imageFiles.length} 个随文章保存的图片文件。`,
);
