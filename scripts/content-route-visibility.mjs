import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/i;

function walkMarkdownFiles(directory) {
	const files = [];

	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkMarkdownFiles(entryPath));
		} else if (entry.isFile() && MARKDOWN_EXTENSION.test(entry.name)) {
			files.push(entryPath);
		}
	}

	return files;
}

function readFrontmatter(filePath) {
	const source = readFileSync(filePath, "utf8");
	const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) {
		return {};
	}

	const parsed = parseYaml(match[1]);
	return parsed && typeof parsed === "object" ? parsed : {};
}

function getContentId(contentDirectory, filePath) {
	const relativePath = path
		.relative(contentDirectory, filePath)
		.replace(/\\/g, "/")
		.replace(MARKDOWN_EXTENSION, "");

	return relativePath.endsWith("/index")
		? relativePath.slice(0, -"/index".length)
		: relativePath;
}

function trimRouteSlashes(value) {
	return String(value ?? "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

function normalizeRoutePath(value) {
	const route = trimRouteSlashes(value);
	return route ? `/${route}/` : "/";
}

function generateConfiguredPermalink(post, postNumber, permalinkConfig) {
	if (post.data.permalink) {
		return trimRouteSlashes(post.data.permalink);
	}

	const published = new Date(post.data.published);
	const postname = post.id;
	const rawPostname = path.basename(
		post.filePath,
		path.extname(post.filePath),
	);
	const category = post.data.category || "uncategorized";

	return permalinkConfig.format
		.replace(/%year%/g, published.getFullYear().toString())
		.replace(
			/%monthnum%/g,
			(published.getMonth() + 1).toString().padStart(2, "0"),
		)
		.replace(/%day%/g, published.getDate().toString().padStart(2, "0"))
		.replace(/%hour%/g, published.getHours().toString().padStart(2, "0"))
		.replace(
			/%minute%/g,
			published.getMinutes().toString().padStart(2, "0"),
		)
		.replace(
			/%second%/g,
			published.getSeconds().toString().padStart(2, "0"),
		)
		.replace(/%post_id%/g, postNumber.toString())
		.replace(/%postname%/g, postname)
		.replace(/%raw_postname%/g, rawPostname)
		.replace(/%category%/g, category);
}

/**
 * Compute every generated HTML route for hidden posts. This runs from
 * astro.config.mjs so the sitemap can omit hidden direct-link pages without
 * removing those pages from the build.
 */
export function getHiddenPostRoutePaths({ contentDirectory, permalinkConfig }) {
	const resolvedDirectory =
		contentDirectory instanceof URL
			? fileURLToPath(contentDirectory)
			: path.resolve(contentDirectory);

	const routablePosts = walkMarkdownFiles(resolvedDirectory)
		.map((filePath) => ({
			id: getContentId(resolvedDirectory, filePath),
			filePath,
			data: readFrontmatter(filePath),
		}))
		.filter(
			(post) =>
				post.data.draft !== true &&
				post.data.trashed !== true &&
				new Date(post.data.published).getTime() <= Date.now(),
		);

	const postsByPublishedDate = [...routablePosts].sort(
		(a, b) =>
			new Date(a.data.published).getTime() -
			new Date(b.data.published).getTime(),
	);
	const postNumbers = new Map(
		postsByPublishedDate.map((post, index) => [post.id, index + 1]),
	);

	const hiddenRoutes = new Set();
	for (const post of routablePosts) {
		if (post.data.hidden !== true) {
			continue;
		}

		// The compatibility /posts/{id}/ route is always generated.
		hiddenRoutes.add(normalizeRoutePath(`posts/${post.id}`));

		if (post.data.permalink || permalinkConfig.enable) {
			const permalink = generateConfiguredPermalink(
				post,
				postNumbers.get(post.id) ?? 0,
				permalinkConfig,
			);
			hiddenRoutes.add(normalizeRoutePath(permalink));
			continue;
		}

		if (post.data.alias) {
			let alias = trimRouteSlashes(post.data.alias);
			if (alias.startsWith("posts/")) {
				alias = alias.replace(/^posts\//, "");
			}
			hiddenRoutes.add(normalizeRoutePath(`posts/${alias}`));
		}
	}

	return hiddenRoutes;
}
