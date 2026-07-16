<script lang="ts">
	import { onMount } from "svelte";

	import {
		AdminApiError,
		type AdminContentCommitOperation,
		type AdminContentRevision,
		commitAdminContent,
		getAdminContent,
	} from "@/lib/supabase";

	import Icon from "./AdminIcon.svelte";
	import type {
		StudioPost,
		StudioPostStatus,
		StudioTaxonomyItem,
		StudioView,
		TaxonomyKind,
	} from "./types";

	export let accessToken = "";
	export let embedded = false;

	type EditorMode = "write" | "split" | "preview";
	type DialogTone = "default" | "danger";

	interface DialogState {
		open: boolean;
		title: string;
		message: string;
		confirmLabel: string;
		inputLabel: string;
		inputPlaceholder: string;
		requiresInput: boolean;
		tone: DialogTone;
		onConfirm: ((value: string) => void | Promise<void>) | null;
	}

	const EMPTY_DIALOG: DialogState = {
		open: false,
		title: "",
		message: "",
		confirmLabel: "确认",
		inputLabel: "",
		inputPlaceholder: "",
		requiresInput: false,
		tone: "default",
		onConfirm: null,
	};

	let posts: StudioPost[] = [];
	let activeView: StudioView = "posts";
	let editorMode: EditorMode = "split";
	let taxonomyKind: TaxonomyKind = "category";
	let editingId = "";
	let editorPost = createEmptyPost();
	let editorBaseline = "";
	let slugTouched = false;
	let tagInput = "";
	let searchQuery = "";
	let statusFilter: "all" | StudioPostStatus | "hidden" | "pinned" = "all";
	let categoryFilter = "all";
	let tagFilter = "all";
	let selectedIds = new Set<string>();
	let feedback = "";
	let feedbackTone: "success" | "info" | "warning" = "info";
	let feedbackTimer: number | undefined;
	let dialog: DialogState = { ...EMPTY_DIALOG };
	let dialogValue = "";
	let taxonomySearch = "";
	let revision: AdminContentRevision | null = null;
	let maxOperations = 0;
	let loadingContent = true;
	let saving = false;
	let loadError = "";
	let contentController: AbortController | null = null;

	onMount(() => {
		void loadContent();

		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editorDirty) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", handleBeforeUnload);

		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
			contentController?.abort();
			if (feedbackTimer) window.clearTimeout(feedbackTimer);
		};
	});

	$: activePosts = posts.filter((post) => post.status !== "trash");
	$: trashedPosts = posts
		.filter((post) => post.status === "trash")
		.sort(sortByUpdated);
	$: categories = summarizeTaxonomy(activePosts, "category");
	$: tags = summarizeTaxonomy(activePosts, "tag");
	$: filteredPosts = activePosts.filter(matchesFilters).sort((a, b) => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		return sortByUpdated(a, b);
	});
	$: visibleSelectedCount = filteredPosts.filter((post) =>
		selectedIds.has(post.id),
	).length;
	$: allVisibleSelected =
		filteredPosts.length > 0 &&
		visibleSelectedCount === filteredPosts.length;
	$: publishedCount = activePosts.filter(
		(post) => post.status === "published",
	).length;
	$: draftCount = activePosts.filter(
		(post) => post.status === "draft",
	).length;
	$: hiddenCount = activePosts.filter((post) => post.hidden).length;
	$: pinnedCount = activePosts.filter((post) => post.pinned).length;
	$: previewHtml = renderMarkdown(editorPost.body);
	$: editorDirty =
		activeView === "editor" &&
		editorBaseline !== "" &&
		snapshotEditor(editorPost) !== editorBaseline;
	$: editorKeepsPublication =
		Boolean(editingId) &&
		(editorPost.status === "published" ||
			editorPost.status === "scheduled");

	function clonePosts(value: StudioPost[]): StudioPost[] {
		return value.map((post) => ({
			...post,
			tags: [...post.tags],
		}));
	}

	function normalizePosts(value: unknown[]): StudioPost[] {
		const validStatuses: StudioPostStatus[] = [
			"published",
			"draft",
			"scheduled",
			"trash",
		];
		return value
			.filter((item): item is Record<string, unknown> =>
				Boolean(
					item &&
					typeof item === "object" &&
					"id" in item &&
					typeof item.id === "string",
				),
			)
			.map((raw) => {
				const fallback = createEmptyPost();
				const stringValue = (key: keyof StudioPost) =>
					typeof raw[key] === "string"
						? String(raw[key])
						: String(fallback[key] ?? "");
				const booleanValue = (
					key: keyof StudioPost,
					fallbackValue: boolean,
				) =>
					typeof raw[key] === "boolean"
						? Boolean(raw[key])
						: fallbackValue;
				const dateValue = (key: "publishedAt" | "updatedAt") => {
					const value = stringValue(key);
					return Number.isNaN(new Date(value).getTime())
						? fallback[key]
						: value;
				};
				const status = validStatuses.includes(
					raw.status as StudioPostStatus,
				)
					? (raw.status as StudioPostStatus)
					: fallback.status;
				const kind = raw.kind === "diary" ? "diary" : "article";

				return {
					...fallback,
					id: String(raw.id),
					sha:
						typeof raw.sha === "string" && raw.sha
							? String(raw.sha)
							: undefined,
					trashPath:
						typeof raw.trashPath === "string" && raw.trashPath
							? String(raw.trashPath)
							: undefined,
					trashedAt:
						typeof raw.trashedAt === "string" && raw.trashedAt
							? String(raw.trashedAt)
							: undefined,
					title: stringValue("title"),
					slug: stringValue("slug"),
					description: stringValue("description"),
					body: stringValue("body"),
					image: stringValue("image"),
					tags: Array.isArray(raw.tags)
						? [
								...new Set(
									raw.tags
										.map(String)
										.map((tag) => tag.trim())
										.filter(Boolean),
								),
							]
						: [],
					category: stringValue("category"),
					kind,
					status,
					hidden: booleanValue("hidden", fallback.hidden),
					pinned: booleanValue("pinned", fallback.pinned),
					priority:
						typeof raw.priority === "number" &&
						Number.isFinite(raw.priority)
							? raw.priority
							: null,
					comment: booleanValue("comment", fallback.comment),
					encrypted: booleanValue("encrypted", fallback.encrypted),
					password: stringValue("password"),
					passwordHint: stringValue("passwordHint"),
					publishedAt: dateValue("publishedAt"),
					updatedAt: dateValue("updatedAt"),
					author: stringValue("author"),
					lang: stringValue("lang"),
					alias: stringValue("alias"),
					permalink: stringValue("permalink"),
					sourceLink: stringValue("sourceLink"),
					licenseName: stringValue("licenseName"),
					licenseUrl: stringValue("licenseUrl"),
				};
			});
	}

	function createEmptyPost(): StudioPost {
		const now = new Date().toISOString();
		return {
			id: "",
			title: "",
			slug: "",
			description: "",
			body: "# 新文章\n\n从这里开始写下正文。",
			image: "",
			tags: [],
			category: "",
			kind: "article",
			status: "draft",
			hidden: false,
			pinned: false,
			priority: null,
			comment: true,
			encrypted: false,
			password: "",
			passwordHint: "",
			publishedAt: now,
			updatedAt: now,
			author: "未花",
			lang: "zh_CN",
			alias: "",
			permalink: "",
			sourceLink: "",
			licenseName: "",
			licenseUrl: "",
		};
	}

	function snapshotEditor(post: StudioPost): string {
		return JSON.stringify(post);
	}

	function readableContentError(error: unknown): string {
		if (error instanceof AdminApiError) {
			if (error.status === 409) {
				return "GitHub 中的文章已经被其他操作更新，请刷新内容后重试。";
			}
			if (
				error.code === "GITHUB_NOT_CONFIGURED" ||
				error.code === "GITHUB_CONTENT_NOT_CONFIGURED" ||
				error.code === "CONTENT_NOT_CONFIGURED"
			) {
				return "内容发布服务尚未配置 GitHub 写入凭据。";
			}
			if (error.code === "GITHUB_AUTH_FAILED") {
				return "GitHub 内容令牌无效或缺少仓库写入权限。";
			}
			return error.message;
		}
		if (error instanceof Error && error.message) return error.message;
		return "无法连接内容发布服务。";
	}

	async function loadContent(showSuccess = false) {
		if (!accessToken.trim()) {
			loadError = "管理员登录已失效，请重新登录。";
			loadingContent = false;
			return;
		}

		contentController?.abort();
		const controller = new AbortController();
		contentController = controller;
		loadingContent = true;
		loadError = "";
		try {
			const result = await getAdminContent(
				accessToken,
				controller.signal,
			);
			posts = normalizePosts(result.posts);
			revision = result.revision;
			maxOperations = result.limits.maxOperations;
			selectedIds = new Set();
			if (showSuccess) {
				showFeedback("已从 GitHub 刷新最新文章。", "success");
			}
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				return;
			}
			loadError = readableContentError(error);
		} finally {
			if (contentController === controller) {
				contentController = null;
				loadingContent = false;
			}
		}
	}

	function expectedSha(post: StudioPost): { expectedSha?: string } {
		return post.sha ? { expectedSha: post.sha } : {};
	}

	function buildCommitOperations(
		previousPosts: StudioPost[],
		nextPosts: StudioPost[],
	): AdminContentCommitOperation[] {
		const before = new Map(previousPosts.map((post) => [post.id, post]));
		const after = new Map(nextPosts.map((post) => [post.id, post]));
		const operations: AdminContentCommitOperation[] = [];

		for (const post of previousPosts) {
			if (!after.has(post.id)) {
				operations.push({
					op: "delete",
					id: post.id,
					...expectedSha(post),
					confirm: true,
				});
			}
		}

		for (const post of nextPosts) {
			const current = before.get(post.id);
			if (!current) {
				operations.push({ op: "save", post });
				continue;
			}
			if (current.status !== "trash" && post.status === "trash") {
				operations.push({
					op: "trash",
					id: current.id,
					...expectedSha(current),
				});
				continue;
			}
			if (current.status === "trash" && post.status !== "trash") {
				operations.push({
					op: "restore",
					id: current.id,
					...expectedSha(current),
					slug: post.slug,
				});
				continue;
			}
			if (JSON.stringify(current) !== JSON.stringify(post)) {
				operations.push({
					op: "save",
					post,
					...expectedSha(current),
				});
			}
		}

		return operations;
	}

	async function updatePosts(
		nextPosts: StudioPost[],
		message?: string,
		explicitOperations?: AdminContentCommitOperation[],
	): Promise<boolean> {
		const previousPosts = clonePosts(posts);
		const optimisticPosts = clonePosts(nextPosts);

		if (saving) {
			showFeedback("正在提交上一项修改，请稍候。", "warning");
			return false;
		}
		if (!revision?.headSha) {
			showFeedback("请先刷新并载入 GitHub 文章。", "warning");
			return false;
		}

		const operations =
			explicitOperations ??
			buildCommitOperations(previousPosts, optimisticPosts);
		if (operations.length === 0) return true;
		if (maxOperations > 0 && operations.length > maxOperations) {
			showFeedback(
				`本次操作涉及 ${operations.length} 篇文章，超过单次上限 ${maxOperations}。`,
				"warning",
			);
			return false;
		}

		posts = optimisticPosts;
		saving = true;
		try {
			const result = await commitAdminContent(accessToken, {
				baseHeadSha: revision.headSha,
				message,
				operations,
			});
			posts = normalizePosts(result.posts);
			revision = result.revision;
			if (message) {
				showFeedback(
					`${message} 已提交 GitHub，Pages 将自动重新部署。`,
					"success",
				);
			}
			return true;
		} catch (error) {
			posts = previousPosts;
			showFeedback(readableContentError(error), "warning");
			return false;
		} finally {
			saving = false;
		}
	}

	function showFeedback(
		message: string,
		tone: "success" | "info" | "warning" = "info",
	) {
		feedback = message;
		feedbackTone = tone;
		if (feedbackTimer) window.clearTimeout(feedbackTimer);
		feedbackTimer = window.setTimeout(() => {
			feedback = "";
			feedbackTimer = undefined;
		}, 4200);
	}

	function statusLabel(post: StudioPost): string {
		if (post.status === "trash") return "回收站";
		if (post.hidden) return "已隐藏";
		if (post.status === "published") return "已发布";
		if (post.status === "scheduled") return "待发布";
		return "草稿";
	}

	function statusClass(post: StudioPost): string {
		if (post.status === "trash") return "trash";
		if (post.hidden) return "hidden";
		return post.status;
	}

	function formatDate(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "日期未知";
		return new Intl.DateTimeFormat("zh-CN", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	}

	function sortByUpdated(a: StudioPost, b: StudioPost): number {
		return (
			new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
		);
	}

	function summarizeTaxonomy(
		source: StudioPost[],
		kind: TaxonomyKind,
	): StudioTaxonomyItem[] {
		const counts = new Map<string, number>();
		for (const post of source) {
			const values =
				kind === "category" ? [post.category || "未分类"] : post.tags;
			for (const raw of values) {
				const value = raw.trim();
				if (!value) continue;
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
		}
		return [...counts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	}

	function matchesFilters(post: StudioPost): boolean {
		const query = searchQuery.trim().toLocaleLowerCase();
		if (
			query &&
			![
				post.title,
				post.description,
				post.slug,
				post.category,
				...post.tags,
			].some((value) => value.toLocaleLowerCase().includes(query))
		) {
			return false;
		}
		if (statusFilter === "hidden" && !post.hidden) return false;
		if (statusFilter === "pinned" && !post.pinned) return false;
		if (
			!["all", "hidden", "pinned"].includes(statusFilter) &&
			post.status !== statusFilter
		) {
			return false;
		}
		if (
			categoryFilter !== "all" &&
			(post.category || "未分类") !== categoryFilter
		) {
			return false;
		}
		if (tagFilter !== "all" && !post.tags.includes(tagFilter)) return false;
		return true;
	}

	function slugify(value: string): string {
		const normalized = value
			.normalize("NFKC")
			.trim()
			.toLocaleLowerCase()
			.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
			.replace(/^-+|-+$/g, "");
		return normalized || `post-${Date.now()}`;
	}

	function uniqueSlug(value: string, currentId = ""): string {
		const base = slugify(value);
		let candidate = base;
		let suffix = 2;
		while (
			posts.some(
				(post) => post.id !== currentId && post.slug === candidate,
			)
		) {
			candidate = `${base}-${suffix}`;
			suffix += 1;
		}
		return candidate;
	}

	function startNewPost() {
		editingId = "";
		editorPost = createEmptyPost();
		editorBaseline = snapshotEditor(editorPost);
		slugTouched = false;
		tagInput = "";
		editorMode = "split";
		activeView = "editor";
	}

	function openNewPost() {
		if (activeView === "editor" && editorDirty) {
			openDialog({
				title: "放弃未保存修改",
				message: "当前文章还有未保存内容。确定新建另一篇文章吗？",
				confirmLabel: "放弃并新建",
				tone: "danger",
				onConfirm: startNewPost,
			});
			return;
		}
		startNewPost();
	}

	function openEditor(post: StudioPost) {
		editingId = post.id;
		editorPost = { ...post, tags: [...post.tags] };
		editorBaseline = snapshotEditor(editorPost);
		slugTouched = true;
		tagInput = "";
		editorMode = "split";
		activeView = "editor";
	}

	function addTag() {
		const values = tagInput
			.split(/[,，]/)
			.map((tag) => tag.trim())
			.filter(Boolean);
		if (values.length === 0) return;
		editorPost = {
			...editorPost,
			tags: [...new Set([...editorPost.tags, ...values])],
		};
		tagInput = "";
	}

	function removeEditorTag(tag: string) {
		editorPost = {
			...editorPost,
			tags: editorPost.tags.filter((item) => item !== tag),
		};
	}

	function ensureEditorValid(): boolean {
		editorPost.title = editorPost.title.trim();
		editorPost.slug = uniqueSlug(
			editorPost.slug || editorPost.title,
			editingId,
		);
		editorPost.category = editorPost.category.trim();
		editorPost.tags = [
			...new Set(
				editorPost.tags.map((tag) => tag.trim()).filter(Boolean),
			),
		];
		if (!editorPost.title) {
			showFeedback("请先填写文章标题。", "warning");
			return false;
		}
		if (!editorPost.body.trim()) {
			showFeedback("文章正文不能为空。", "warning");
			return false;
		}
		return true;
	}

	async function saveEditor(status: "draft" | "published", message?: string) {
		if (!ensureEditorValid()) return;
		const now = new Date().toISOString();
		const id = editingId || `${editorPost.slug}.md`;
		const next: StudioPost = {
			...editorPost,
			id,
			status,
			updatedAt: now,
			publishedAt:
				status === "published" && !editorPost.publishedAt
					? now
					: editorPost.publishedAt,
			priority: editorPost.pinned
				? Math.max(0, Number(editorPost.priority ?? 0))
				: null,
		};
		const exists = posts.some((post) => post.id === id);
		const nextPosts = exists
			? posts.map((post) => (post.id === id ? next : post))
			: [next, ...posts];
		const schedulesFuturePublish =
			status === "published" &&
			new Date(next.publishedAt).getTime() > Date.now();
		const saved = await updatePosts(
			nextPosts,
			message ??
				(status === "published"
					? schedulesFuturePublish
						? "文章已预约发布。"
						: "文章已发布。"
					: "草稿已保存。"),
		);
		if (!saved) return;
		const persisted =
			posts.find((post) => post.id === id || post.slug === next.slug) ??
			next;
		editingId = persisted.id;
		editorPost = { ...persisted, tags: [...persisted.tags] };
		editorBaseline = snapshotEditor(editorPost);
		slugTouched = true;
	}

	function saveDraftOrChanges() {
		if (editorKeepsPublication) {
			void saveEditor("published", "文章修改已保存，发布状态保持不变。");
			return;
		}
		void saveEditor("draft");
	}

	function toggleSelected(id: string) {
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	function toggleSelectAll() {
		const next = new Set(selectedIds);
		if (allVisibleSelected) {
			for (const post of filteredPosts) next.delete(post.id);
		} else {
			for (const post of filteredPosts) next.add(post.id);
		}
		selectedIds = next;
	}

	function clearSelection() {
		selectedIds = new Set();
	}

	async function patchPost(
		id: string,
		patch: Partial<StudioPost>,
		message?: string,
	): Promise<boolean> {
		const now = new Date().toISOString();
		return updatePosts(
			posts.map((post) =>
				post.id === id ? { ...post, ...patch, updatedAt: now } : post,
			),
			message,
		);
	}

	function togglePinned(post: StudioPost) {
		void patchPost(
			post.id,
			{
				pinned: !post.pinned,
				priority: post.pinned ? null : (post.priority ?? 0),
			},
			post.pinned ? "已取消置顶。" : "文章已置顶。",
		);
	}

	function toggleHidden(post: StudioPost) {
		void patchPost(
			post.id,
			{ hidden: !post.hidden },
			post.hidden ? "文章已恢复展示。" : "文章已设为隐藏。",
		);
	}

	function moveToTrash(post: StudioPost) {
		openDialog({
			title: "移入回收站",
			message: `“${post.title}”将从文章列表移除，可以稍后恢复。`,
			confirmLabel: "移入回收站",
			tone: "danger",
			onConfirm: async () => {
				const moved = await patchPost(
					post.id,
					{
						status: "trash",
						hidden: true,
						pinned: false,
						priority: null,
					},
					"文章已移入回收站。",
				);
				if (!moved) return;
				selectedIds.delete(post.id);
				selectedIds = new Set(selectedIds);
				if (editingId === post.id) {
					editingId = "";
					editorPost = createEmptyPost();
					editorBaseline = "";
					slugTouched = false;
					activeView = "trash";
				}
			},
		});
	}

	async function duplicatePost(post: StudioPost) {
		const now = new Date().toISOString();
		const slug = uniqueSlug(`${post.slug}-copy`);
		const copy: StudioPost = {
			...post,
			id: `${slug}.md`,
			title: `${post.title}（副本）`,
			slug,
			status: "draft",
			hidden: false,
			pinned: false,
			priority: null,
			updatedAt: now,
			publishedAt: now,
			alias: "",
			permalink: "",
			tags: [...post.tags],
		};
		const saved = await updatePosts(
			[copy, ...posts],
			"文章副本已创建并保存为草稿。",
		);
		if (!saved) return;
		openEditor(posts.find((item) => item.slug === slug) ?? copy);
	}

	async function applyBulkPatch(patch: Partial<StudioPost>, message: string) {
		const now = new Date().toISOString();
		const updated = await updatePosts(
			posts.map((post) =>
				selectedIds.has(post.id)
					? { ...post, ...patch, updatedAt: now }
					: post,
			),
			message,
		);
		if (updated) clearSelection();
	}

	function bulkPublish() {
		void applyBulkPatch(
			{ status: "published" },
			`${selectedIds.size} 篇文章已设为发布。`,
		);
	}

	function bulkHide() {
		void applyBulkPatch(
			{ hidden: true },
			`${selectedIds.size} 篇文章已隐藏。`,
		);
	}

	function bulkMoveCategory() {
		openDialog({
			title: "批量修改分类",
			message: `将 ${selectedIds.size} 篇文章移动到指定分类。留空则设为未分类。`,
			confirmLabel: "应用分类",
			inputLabel: "目标分类",
			inputPlaceholder: "例如：技术",
			requiresInput: true,
			onConfirm: (value) =>
				applyBulkPatch(
					{ category: value.trim() },
					`${selectedIds.size} 篇文章的分类已更新。`,
				),
		});
	}

	function bulkAddTag() {
		openDialog({
			title: "批量添加标签",
			message: `为 ${selectedIds.size} 篇文章添加标签，多个标签使用逗号分隔。`,
			confirmLabel: "添加标签",
			inputLabel: "标签",
			inputPlaceholder: "Markdown, 教程",
			requiresInput: true,
			onConfirm: async (value) => {
				const additions = value
					.split(/[,，]/)
					.map((tag) => tag.trim())
					.filter(Boolean);
				if (additions.length === 0) return;
				const now = new Date().toISOString();
				const updated = await updatePosts(
					posts.map((post) =>
						selectedIds.has(post.id)
							? {
									...post,
									tags: [
										...new Set([
											...post.tags,
											...additions,
										]),
									],
									updatedAt: now,
								}
							: post,
					),
					`已为 ${selectedIds.size} 篇文章添加标签。`,
				);
				if (updated) clearSelection();
			},
		});
	}

	function bulkTrash() {
		openDialog({
			title: "批量移入回收站",
			message: `确定将选中的 ${selectedIds.size} 篇文章移入回收站吗？`,
			confirmLabel: "确认移入",
			tone: "danger",
			onConfirm: () =>
				applyBulkPatch(
					{
						status: "trash",
						hidden: true,
						pinned: false,
						priority: null,
					},
					"选中文章已移入回收站。",
				),
		});
	}

	function restorePost(post: StudioPost) {
		void patchPost(
			post.id,
			{ status: "draft", hidden: false },
			"文章已恢复为草稿。",
		);
	}

	function permanentlyDelete(post: StudioPost) {
		openDialog({
			title: "永久删除文章",
			message: `此操作无法撤销。请输入文章标题“${post.title}”进行确认。`,
			confirmLabel: "永久删除",
			inputLabel: "文章标题",
			inputPlaceholder: post.title,
			requiresInput: true,
			tone: "danger",
			onConfirm: async (value) => {
				if (value !== post.title) {
					showFeedback("标题不匹配，已取消永久删除。", "warning");
					return;
				}
				await updatePosts(
					posts.filter((item) => item.id !== post.id),
					"文章已永久删除。",
				);
			},
		});
	}

	function refreshContent() {
		const refresh = () => {
			editingId = "";
			editorPost = createEmptyPost();
			editorBaseline = "";
			slugTouched = false;
			activeView = "posts";
			void loadContent(true);
		};
		if (activeView === "editor" && editorDirty) {
			openDialog({
				title: "放弃未保存修改",
				message: "刷新会重新读取 GitHub 内容，当前未保存修改将丢失。",
				confirmLabel: "放弃并刷新",
				tone: "danger",
				onConfirm: refresh,
			});
			return;
		}
		refresh();
	}

	function relatedPostTitles(
		item: StudioTaxonomyItem,
		kind: TaxonomyKind,
	): string {
		const related = activePosts
			.filter((post) =>
				kind === "category"
					? (post.category || "未分类") === item.name
					: post.tags.includes(item.name),
			)
			.slice(0, 3)
			.map((post) => post.title);
		return related.join("、") || "暂无文章";
	}

	function renameTaxonomy(item: StudioTaxonomyItem) {
		openDialog({
			title: `重命名${taxonomyKind === "category" ? "分类" : "标签"}`,
			message: `所有引用“${item.name}”的文章都会同步更新。`,
			confirmLabel: "保存名称",
			inputLabel: "新名称",
			inputPlaceholder: item.name,
			requiresInput: true,
			initialValue: item.name,
			onConfirm: async (value) => {
				const target = value.trim();
				if (!target || target === item.name) return;
				await rewriteTaxonomy(
					item.name,
					target,
					`“${item.name}”已重命名为“${target}”。`,
					"rename",
				);
			},
		});
	}

	function mergeTaxonomy(item: StudioTaxonomyItem) {
		openDialog({
			title: `合并${taxonomyKind === "category" ? "分类" : "标签"}`,
			message: `把“${item.name}”的全部文章迁移到另一个名称。`,
			confirmLabel: "合并",
			inputLabel: "目标名称",
			inputPlaceholder:
				taxonomyKind === "category" ? "例如：技术" : "例如：Markdown",
			requiresInput: true,
			onConfirm: async (value) => {
				const target = value.trim();
				if (!target || target === item.name) return;
				await rewriteTaxonomy(
					item.name,
					target,
					`“${item.name}”已合并到“${target}”。`,
					"merge",
				);
			},
		});
	}

	async function rewriteTaxonomy(
		from: string,
		to: string,
		message: string,
		mode: "rename" | "merge",
	) {
		const now = new Date().toISOString();
		const nextPosts = posts.map((post) => {
			if (taxonomyKind === "category") {
				const normalized = post.category || "未分类";
				return normalized === from
					? {
							...post,
							category: to === "未分类" ? "" : to,
							updatedAt: now,
						}
					: post;
			}
			if (!post.tags.includes(from)) return post;
			return {
				...post,
				tags: [
					...new Set(
						post.tags
							.map((tag) => (tag === from ? to : tag))
							.filter(Boolean),
					),
				],
				updatedAt: now,
			};
		});
		await updatePosts(nextPosts, message, [
			{
				op: "taxonomy",
				taxonomy: taxonomyKind,
				mode,
				from,
				to,
			},
		]);
	}

	function deleteTaxonomy(item: StudioTaxonomyItem) {
		if (taxonomyKind === "category" && item.name === "未分类") {
			showFeedback(
				"“未分类”是系统归集项，不能删除；可以使用“归类”迁移文章。",
				"warning",
			);
			return;
		}
		const noun = taxonomyKind === "category" ? "分类" : "标签";
		openDialog({
			title: `删除${noun}`,
			message:
				taxonomyKind === "category"
					? `关联的 ${item.count} 篇文章将变为“未分类”，文章本身不会删除。`
					: `将从 ${item.count} 篇文章中移除“${item.name}”，文章本身不会删除。`,
			confirmLabel: `删除${noun}`,
			tone: "danger",
			onConfirm: async () => {
				const now = new Date().toISOString();
				const nextPosts = posts.map((post) => {
					if (taxonomyKind === "category") {
						return (post.category || "未分类") === item.name
							? { ...post, category: "", updatedAt: now }
							: post;
					}
					return post.tags.includes(item.name)
						? {
								...post,
								tags: post.tags.filter(
									(tag) => tag !== item.name,
								),
								updatedAt: now,
							}
						: post;
				});
				await updatePosts(nextPosts, `${noun}“${item.name}”已删除。`, [
					{
						op: "taxonomy",
						taxonomy: taxonomyKind,
						mode: "delete",
						from: item.name,
					},
				]);
			},
		});
	}

	function openDialog(
		options: Partial<DialogState> & {
			title: string;
			message: string;
			onConfirm: (value: string) => void | Promise<void>;
			initialValue?: string;
		},
	) {
		dialogValue = options.initialValue ?? "";
		dialog = {
			...EMPTY_DIALOG,
			...options,
			open: true,
		};
	}

	function closeDialog() {
		dialog = { ...EMPTY_DIALOG };
		dialogValue = "";
	}

	function submitDialog() {
		const handler = dialog.onConfirm;
		const value = dialogValue;
		closeDialog();
		void handler?.(value);
	}

	function escapeHtml(value: string): string {
		return value
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#039;");
	}

	function renderInline(value: string): string {
		return value
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>")
			.replace(
				/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
				'<a href="$2" target="_blank" rel="noreferrer">$1</a>',
			);
	}

	function renderMarkdown(source: string): string {
		const lines = escapeHtml(source).split(/\r?\n/);
		const output: string[] = [];
		let inCode = false;
		let code: string[] = [];
		let inList = false;

		const closeList = () => {
			if (inList) output.push("</ul>");
			inList = false;
		};

		for (const line of lines) {
			if (line.startsWith("```")) {
				closeList();
				if (inCode) {
					output.push(`<pre><code>${code.join("\n")}</code></pre>`);
					code = [];
				}
				inCode = !inCode;
				continue;
			}
			if (inCode) {
				code.push(line);
				continue;
			}
			const heading = /^(#{1,6})\s+(.+)$/.exec(line);
			if (heading) {
				closeList();
				const level = heading[1].length;
				output.push(
					`<h${level}>${renderInline(heading[2])}</h${level}>`,
				);
				continue;
			}
			const listItem = /^[-*]\s+(.+)$/.exec(line);
			if (listItem) {
				if (!inList) {
					output.push("<ul>");
					inList = true;
				}
				output.push(`<li>${renderInline(listItem[1])}</li>`);
				continue;
			}
			closeList();
			if (/^&gt;\s?/.test(line)) {
				output.push(
					`<blockquote>${renderInline(line.replace(/^&gt;\s?/, ""))}</blockquote>`,
				);
			} else if (line.trim()) {
				output.push(`<p>${renderInline(line)}</p>`);
			}
		}
		closeList();
		if (code.length)
			output.push(`<pre><code>${code.join("\n")}</code></pre>`);
		return output.join("");
	}

	function onEditorTitleInput() {
		if (!slugTouched) {
			editorPost = {
				...editorPost,
				slug: slugify(editorPost.title),
			};
		}
	}

	function onEditorSlugInput() {
		slugTouched = true;
	}

	function formatDateTimeInput(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "";
		const localDate = new Date(
			date.getTime() - date.getTimezoneOffset() * 60_000,
		);
		return localDate.toISOString().slice(0, 16);
	}

	function updatePublishedAt(value: string) {
		const nextDate = new Date(value);
		if (Number.isNaN(nextDate.getTime())) {
			showFeedback("请选择有效的发布日期。", "warning");
			return;
		}
		editorPost = {
			...editorPost,
			publishedAt: nextDate.toISOString(),
		};
	}

	function performNavigate(view: StudioView) {
		activeView = view;
		if (view !== "posts") clearSelection();
	}

	function navigateTo(view: StudioView) {
		if (activeView === "editor" && view !== "editor" && editorDirty) {
			openDialog({
				title: "放弃未保存修改",
				message: "当前文章还有未保存内容。确定离开编辑器吗？",
				confirmLabel: "放弃并离开",
				tone: "danger",
				onConfirm: () => performNavigate(view),
			});
			return;
		}
		performNavigate(view);
	}
</script>

<svelte:head>
	<meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section
	class="studio-shell"
	class:embedded
	class:saving
	aria-busy={loadingContent || saving}
	aria-labelledby="content-studio-title"
>
	<header class="studio-hero">
		<div class="hero-copy">
			<div class="preview-label">
				<span class="preview-dot"></span>
				GitHub 内容仓库
			</div>
			<h1 id="content-studio-title">
				{embedded ? "内容发布中心" : "站长内容工作台"}
			</h1>
			<p>集中管理文章发布、草稿、置顶、隐藏、分类、标签与回收站。</p>
		</div>
		<div class="hero-actions">
			<button
				class="secondary-button"
				type="button"
				on:click={refreshContent}
				disabled={loadingContent || saving}
			>
				<Icon icon="material-symbols:refresh-rounded" />
				刷新 GitHub 内容
			</button>
			<button
				class="primary-button"
				type="button"
				on:click={openNewPost}
				disabled={loadingContent || saving || Boolean(loadError)}
			>
				<Icon icon="material-symbols:add-rounded" />
				新建文章
			</button>
		</div>
	</header>

	<div class="prototype-notice live">
		<Icon icon="material-symbols:verified-user-rounded" />
		<div>
			<strong>管理员写入通道：修改将提交到 GitHub</strong>
			<span>
				{revision
					? `${revision.repository} · ${revision.branch} · ${revision.headSha.slice(0, 7)}`
					: "完成身份核验后，服务端会读取内容仓库。"}
			</span>
		</div>
		<div class="flow">
			<span>Markdown</span><i>→</i><span>GitHub 构建</span><i>→</i><span
				>博客上线</span
			>
		</div>
	</div>

	{#if saving}
		<div class="saving-badge" role="status">
			<span class="studio-spinner"></span>
			正在提交 GitHub，请勿关闭页面…
		</div>
	{/if}

	{#if loadingContent}
		<div class="content-state" role="status">
			<span class="studio-spinner"></span>
			<div>
				<strong>正在读取 GitHub 文章</strong>
				<span>正文只会在管理员身份核验完成后载入。</span>
			</div>
		</div>
	{:else if loadError}
		<div class="content-state error" role="alert">
			<Icon icon="material-symbols:cloud-off-rounded" />
			<div>
				<strong>内容发布服务不可用</strong>
				<span>{loadError}</span>
			</div>
			<button
				class="secondary-button"
				type="button"
				on:click={() => loadContent()}
			>
				重新连接
			</button>
		</div>
	{:else}
		<nav class="studio-nav" aria-label="内容工作台栏目">
			<button
				type="button"
				class:active={activeView === "posts"}
				on:click={() => navigateTo("posts")}
			>
				<Icon icon="material-symbols:article-rounded" />
				<span>文章管理</span>
				<strong>{activePosts.length}</strong>
			</button>
			<button
				type="button"
				class:active={activeView === "taxonomy"}
				on:click={() => navigateTo("taxonomy")}
			>
				<Icon icon="material-symbols:category-rounded" />
				<span>分类与标签</span>
				<strong>{categories.length + tags.length}</strong>
			</button>
			<button
				type="button"
				class:active={activeView === "trash"}
				on:click={() => navigateTo("trash")}
			>
				<Icon icon="material-symbols:delete-outline-rounded" />
				<span>回收站</span>
				{#if trashedPosts.length}<strong>{trashedPosts.length}</strong
					>{/if}
			</button>
		</nav>

		{#if feedback}
			<div
				class:warning={feedbackTone === "warning"}
				class="feedback-toast"
			>
				<Icon
					icon={feedbackTone === "success"
						? "material-symbols:check-circle-rounded"
						: feedbackTone === "warning"
							? "material-symbols:warning-rounded"
							: "material-symbols:info-rounded"}
				/>
				{feedback}
			</div>
		{/if}

		{#if activeView === "posts"}
			<div class="stats-grid">
				<article>
					<div class="stat-icon published">
						<Icon icon="material-symbols:public-rounded" />
					</div>
					<div>
						<strong>{publishedCount}</strong><span>已发布</span>
					</div>
				</article>
				<article>
					<div class="stat-icon draft">
						<Icon icon="material-symbols:edit-note-rounded" />
					</div>
					<div><strong>{draftCount}</strong><span>草稿</span></div>
				</article>
				<article>
					<div class="stat-icon hidden">
						<Icon icon="material-symbols:visibility-off-rounded" />
					</div>
					<div><strong>{hiddenCount}</strong><span>已隐藏</span></div>
				</article>
				<article>
					<div class="stat-icon pinned">
						<Icon icon="material-symbols:push-pin-rounded" />
					</div>
					<div>
						<strong>{pinnedCount}</strong><span>置顶文章</span>
					</div>
				</article>
			</div>

			<section class="panel">
				<div class="panel-heading">
					<div>
						<p class="eyebrow">Content library</p>
						<h2>全部文章</h2>
						<span>支持搜索、筛选、批量操作和快速状态切换。</span>
					</div>
					<button
						class="primary-button compact"
						type="button"
						on:click={openNewPost}
					>
						<Icon icon="material-symbols:add-rounded" />
						写文章
					</button>
				</div>

				<div class="filter-toolbar">
					<label class="search-field">
						<Icon icon="material-symbols:search-rounded" />
						<input
							type="search"
							bind:value={searchQuery}
							on:input={clearSelection}
							placeholder="搜索标题、摘要、标签或链接"
						/>
					</label>
					<select
						bind:value={statusFilter}
						on:change={clearSelection}
						aria-label="按状态筛选"
					>
						<option value="all">全部状态</option>
						<option value="published">已发布</option>
						<option value="draft">草稿</option>
						<option value="scheduled">待发布</option>
						<option value="hidden">已隐藏</option>
						<option value="pinned">已置顶</option>
					</select>
					<select
						bind:value={categoryFilter}
						on:change={clearSelection}
						aria-label="按分类筛选"
					>
						<option value="all">全部分类</option>
						{#each categories as item}
							<option value={item.name}
								>{item.name}（{item.count}）</option
							>
						{/each}
					</select>
					<select
						bind:value={tagFilter}
						on:change={clearSelection}
						aria-label="按标签筛选"
					>
						<option value="all">全部标签</option>
						{#each tags as item}
							<option value={item.name}
								>{item.name}（{item.count}）</option
							>
						{/each}
					</select>
				</div>

				{#if selectedIds.size > 0}
					<div class="bulk-toolbar">
						<div>
							<button
								class="selection-check checked"
								type="button"
								on:click={clearSelection}
								aria-label="清除选择"
							>
								<Icon icon="material-symbols:check-rounded" />
							</button>
							<strong>已选 {selectedIds.size} 篇</strong>
						</div>
						<div class="bulk-actions">
							<button type="button" on:click={bulkPublish}>
								<Icon
									icon="material-symbols:publish-rounded"
								/>发布
							</button>
							<button type="button" on:click={bulkHide}>
								<Icon
									icon="material-symbols:visibility-off-rounded"
								/>隐藏
							</button>
							<button type="button" on:click={bulkMoveCategory}>
								<Icon
									icon="material-symbols:drive-file-move-rounded"
								/>改分类
							</button>
							<button type="button" on:click={bulkAddTag}>
								<Icon
									icon="material-symbols:new-label-rounded"
								/>加标签
							</button>
							<button
								class="danger"
								type="button"
								on:click={bulkTrash}
							>
								<Icon
									icon="material-symbols:delete-outline-rounded"
								/>回收站
							</button>
						</div>
					</div>
				{/if}

				<div class="post-table">
					<div class="post-table-head">
						<button
							class:checked={allVisibleSelected}
							class="selection-check"
							type="button"
							on:click={toggleSelectAll}
							aria-label="全选当前筛选结果"
						>
							{#if allVisibleSelected}<Icon
									icon="material-symbols:check-rounded"
								/>{/if}
						</button>
						<span>文章</span><span>状态</span><span>更新时间</span
						><span>操作</span>
					</div>
					{#if filteredPosts.length === 0}
						<div class="empty-state">
							<Icon icon="material-symbols:search-off-rounded" />
							<strong>没有符合条件的文章</strong>
							<span>尝试清空筛选条件，或者创建一篇新文章。</span>
						</div>
					{:else}
						{#each filteredPosts as post (post.id)}
							<article
								class:selected={selectedIds.has(post.id)}
								class="post-row"
							>
								<button
									class:checked={selectedIds.has(post.id)}
									class="selection-check"
									type="button"
									on:click={() => toggleSelected(post.id)}
									aria-label={`选择 ${post.title}`}
								>
									{#if selectedIds.has(post.id)}<Icon
											icon="material-symbols:check-rounded"
										/>{/if}
								</button>
								<button
									class="post-main"
									type="button"
									on:click={() => openEditor(post)}
								>
									<div class="post-title-line">
										{#if post.pinned}<Icon
												class="pin-icon"
												icon="material-symbols:push-pin-rounded"
											/>{/if}
										<strong>{post.title}</strong>
										{#if post.encrypted}<Icon
												class="lock-icon"
												icon="material-symbols:lock-rounded"
											/>{/if}
									</div>
									<p>{post.description || "暂无文章摘要"}</p>
									<div class="post-meta">
										<span
											><Icon
												icon="material-symbols:folder-rounded"
											/>{post.category || "未分类"}</span
										>
										<span
											><Icon
												icon="material-symbols:link-rounded"
											/>/{post.slug}</span
										>
										{#each post.tags.slice(0, 3) as tag}
											<i>#{tag}</i>
										{/each}
										{#if post.tags.length > 3}<i
												>+{post.tags.length - 3}</i
											>{/if}
									</div>
								</button>
								<div class="status-cell">
									<span
										class={`status-badge ${statusClass(post)}`}
									>
										<i></i>{statusLabel(post)}
									</span>
									{#if post.comment}<small>评论开启</small
										>{:else}<small>评论关闭</small>{/if}
								</div>
								<time datetime={post.updatedAt}
									>{formatDate(post.updatedAt)}</time
								>
								<div class="row-actions">
									<button
										type="button"
										on:click={() => openEditor(post)}
										title="编辑文章"
										aria-label={`编辑文章：${post.title}`}
									>
										<Icon
											icon="material-symbols:edit-rounded"
										/>
									</button>
									<button
										class:active={post.pinned}
										type="button"
										on:click={() => togglePinned(post)}
										title={post.pinned
											? "取消置顶"
											: "置顶文章"}
										aria-label={`${post.pinned ? "取消置顶" : "置顶文章"}：${post.title}`}
									>
										<Icon
											icon="material-symbols:push-pin-rounded"
										/>
									</button>
									<button
										class:active={post.hidden}
										type="button"
										on:click={() => toggleHidden(post)}
										title={post.hidden
											? "恢复展示"
											: "隐藏文章"}
										aria-label={`${post.hidden ? "恢复展示" : "隐藏文章"}：${post.title}`}
									>
										<Icon
											icon={post.hidden
												? "material-symbols:visibility-rounded"
												: "material-symbols:visibility-off-rounded"}
										/>
									</button>
									<button
										type="button"
										on:click={() => duplicatePost(post)}
										title="创建副本"
										aria-label={`创建副本：${post.title}`}
									>
										<Icon
											icon="material-symbols:content-copy-rounded"
										/>
									</button>
									<button
										class="danger"
										type="button"
										on:click={() => moveToTrash(post)}
										title="移入回收站"
										aria-label={`移入回收站：${post.title}`}
									>
										<Icon
											icon="material-symbols:delete-outline-rounded"
										/>
									</button>
								</div>
							</article>
						{/each}
					{/if}
				</div>
			</section>
		{:else if activeView === "editor"}
			<section class="editor-shell">
				<header class="editor-header">
					<div>
						<button
							class="back-button"
							type="button"
							on:click={() => navigateTo("posts")}
						>
							<Icon icon="material-symbols:arrow-back-rounded" />
						</button>
						<div>
							<p class="eyebrow">
								{editingId ? "编辑文章" : "新建文章"}
							</p>
							<h2>{editorPost.title || "未命名文章"}</h2>
						</div>
					</div>
					<div class="editor-actions">
						<button
							class="secondary-button"
							type="button"
							on:click={saveDraftOrChanges}
						>
							<Icon icon="material-symbols:save-rounded" />
							{editorKeepsPublication ? "保存修改" : "保存草稿"}
						</button>
						<button
							class="primary-button"
							type="button"
							on:click={() => saveEditor("published")}
						>
							<Icon
								icon="material-symbols:rocket-launch-rounded"
							/>
							{editorPost.status === "scheduled"
								? "更新预约"
								: editingId && editorPost.status === "published"
									? "更新发布"
									: "发布文章"}
						</button>
					</div>
				</header>

				<div class="editor-layout">
					<div class="editor-main">
						<div class="title-editor">
							<input
								class="title-input"
								bind:value={editorPost.title}
								on:input={onEditorTitleInput}
								placeholder="输入文章标题"
								aria-label="文章标题"
							/>
							<div class="slug-line">
								<span>文章链接</span>
								<code>/posts/</code>
								<input
									bind:value={editorPost.slug}
									on:input={onEditorSlugInput}
									placeholder="article-slug"
									aria-label="文章链接"
								/>
								<code>/</code>
							</div>
							<textarea
								class="description-input"
								bind:value={editorPost.description}
								rows="2"
								maxlength="320"
								placeholder="填写一段简洁的文章摘要，用于首页卡片和搜索结果。"
							></textarea>
							<span class="character-count"
								>{editorPost.description.length}/320</span
							>
						</div>

						<div class="editor-workspace">
							<div class="editor-mode-tabs">
								<button
									class:active={editorMode === "write"}
									type="button"
									on:click={() => (editorMode = "write")}
								>
									<Icon
										icon="material-symbols:edit-note-rounded"
									/>编辑
								</button>
								<button
									class:active={editorMode === "split"}
									type="button"
									on:click={() => (editorMode = "split")}
								>
									<Icon
										icon="material-symbols:vertical-split-rounded"
									/>分屏
								</button>
								<button
									class:active={editorMode === "preview"}
									type="button"
									on:click={() => (editorMode = "preview")}
								>
									<Icon
										icon="material-symbols:visibility-rounded"
									/>预览
								</button>
								<span>Markdown</span>
							</div>
							<div class={`editor-panes mode-${editorMode}`}>
								{#if editorMode !== "preview"}
									<textarea
										class="markdown-editor"
										bind:value={editorPost.body}
										spellcheck="false"
										aria-label="Markdown 正文"
									></textarea>
								{/if}
								{#if editorMode !== "write"}
									<div class="markdown-preview">
										{#if previewHtml}
											{@html previewHtml}
										{:else}
											<div class="preview-empty">
												正文预览会显示在这里。
											</div>
										{/if}
									</div>
								{/if}
							</div>
						</div>
					</div>

					<aside class="editor-sidebar">
						<section class="setting-card">
							<div class="setting-title">
								<Icon icon="material-symbols:publish-rounded" />
								<div>
									<strong>发布设置</strong><span
										>控制文章公开状态</span
									>
								</div>
							</div>
							<label>
								<span>发布日期</span>
								<input
									type="datetime-local"
									value={formatDateTimeInput(
										editorPost.publishedAt,
									)}
									on:input={(event) =>
										updatePublishedAt(
											event.currentTarget.value,
										)}
								/>
							</label>
							<div class="toggle-row">
								<div>
									<strong>置顶文章</strong><span
										>显示在首页文章顶部</span
									>
								</div>
								<button
									class:on={editorPost.pinned}
									class="switch"
									type="button"
									on:click={() =>
										(editorPost = {
											...editorPost,
											pinned: !editorPost.pinned,
											priority: editorPost.pinned
												? null
												: (editorPost.priority ?? 0),
										})}
									aria-label="切换置顶"><i></i></button
								>
							</div>
							{#if editorPost.pinned}
								<label>
									<span>置顶优先级</span>
									<input
										type="number"
										min="0"
										bind:value={editorPost.priority}
									/>
									<small>数字越小，排序越靠前。</small>
								</label>
							{/if}
							<div class="toggle-row">
								<div>
									<strong>隐藏文章</strong><span
										>不进入公开列表</span
									>
								</div>
								<button
									class:on={editorPost.hidden}
									class="switch"
									type="button"
									on:click={() =>
										(editorPost = {
											...editorPost,
											hidden: !editorPost.hidden,
										})}
									aria-label="切换隐藏"><i></i></button
								>
							</div>
							<div class="toggle-row">
								<div>
									<strong>开放评论</strong><span
										>允许读者参与讨论</span
									>
								</div>
								<button
									class:on={editorPost.comment}
									class="switch"
									type="button"
									on:click={() =>
										(editorPost = {
											...editorPost,
											comment: !editorPost.comment,
										})}
									aria-label="切换评论"><i></i></button
								>
							</div>
						</section>

						<section class="setting-card">
							<div class="setting-title">
								<Icon
									icon="material-symbols:category-rounded"
								/>
								<div>
									<strong>组织内容</strong><span
										>分类与标签</span
									>
								</div>
							</div>
							<label>
								<span>分类</span>
								<input
									bind:value={editorPost.category}
									list="studio-category-options"
									placeholder="未分类"
								/>
								<datalist id="studio-category-options">
									{#each categories as item}<option
											value={item.name}
										></option>{/each}
								</datalist>
							</label>
							<label>
								<span>标签</span>
								<div class="tag-input-row">
									<input
										bind:value={tagInput}
										placeholder="输入标签后回车"
										on:keydown={(event) => {
											if (event.key === "Enter") {
												event.preventDefault();
												addTag();
											}
										}}
									/>
									<button type="button" on:click={addTag}>
										<Icon
											icon="material-symbols:add-rounded"
										/>
									</button>
								</div>
							</label>
							{#if editorPost.tags.length}
								<div class="tag-list">
									{#each editorPost.tags as tag}
										<button
											type="button"
											on:click={() =>
												removeEditorTag(tag)}
										>
											#{tag}<Icon
												icon="material-symbols:close-rounded"
											/>
										</button>
									{/each}
								</div>
							{:else}
								<p class="setting-hint">尚未添加标签。</p>
							{/if}
						</section>

						<section class="setting-card">
							<div class="setting-title">
								<Icon icon="material-symbols:image-rounded" />
								<div>
									<strong>封面与高级项</strong><span
										>文章展示信息</span
									>
								</div>
							</div>
							<label>
								<span>封面路径或网址</span>
								<input
									bind:value={editorPost.image}
									placeholder="/assets/cover.webp"
								/>
							</label>
							<label>
								<span>内容类型</span>
								<select bind:value={editorPost.kind}>
									<option value="article">文章</option>
									<option value="diary">日记</option>
								</select>
							</label>
							<label>
								<span>作者</span>
								<input
									bind:value={editorPost.author}
									placeholder="未花"
								/>
							</label>
							<label>
								<span>语言</span>
								<input
									bind:value={editorPost.lang}
									placeholder="zh_CN"
								/>
							</label>
							<details>
								<summary>链接与加密设置</summary>
								<label>
									<span>Alias</span>
									<input
										bind:value={editorPost.alias}
										placeholder="可选别名"
									/>
								</label>
								<label>
									<span>Permalink</span>
									<input
										bind:value={editorPost.permalink}
										placeholder="/custom-path/"
									/>
								</label>
								<label>
									<span>来源链接</span>
									<input
										bind:value={editorPost.sourceLink}
										placeholder="https://example.com/source"
									/>
								</label>
								<label>
									<span>许可证名称</span>
									<input
										bind:value={editorPost.licenseName}
										placeholder="CC BY-NC-SA 4.0"
									/>
								</label>
								<label>
									<span>许可证链接</span>
									<input
										bind:value={editorPost.licenseUrl}
										placeholder="https://creativecommons.org/..."
									/>
								</label>
								<div class="toggle-row">
									<div>
										<strong>加密文章</strong><span
											>发布时需要密码</span
										>
									</div>
									<button
										class:on={editorPost.encrypted}
										class="switch"
										type="button"
										on:click={() =>
											(editorPost = {
												...editorPost,
												encrypted:
													!editorPost.encrypted,
											})}
										aria-label="切换加密"><i></i></button
									>
								</div>
								{#if editorPost.encrypted}
									<label>
										<span>文章密码</span>
										<input
											type="password"
											bind:value={editorPost.password}
											autocomplete="new-password"
											placeholder="输入访问密码"
										/>
									</label>
									<label>
										<span>密码提示</span>
										<input
											bind:value={editorPost.passwordHint}
											placeholder="给读者的提示"
										/>
									</label>
								{/if}
							</details>
						</section>

						{#if editingId}
							<button
								class="danger-zone"
								type="button"
								on:click={() => moveToTrash(editorPost)}
							>
								<Icon
									icon="material-symbols:delete-outline-rounded"
								/>
								移入回收站
							</button>
						{/if}
					</aside>
				</div>
			</section>
		{:else if activeView === "taxonomy"}
			<section class="panel taxonomy-panel">
				<div class="panel-heading taxonomy-heading">
					<div>
						<p class="eyebrow">Taxonomy</p>
						<h2>分类与标签管理</h2>
						<span>
							这些项目由文章自动汇总；重命名、合并或删除会同步修改关联文章。
						</span>
					</div>
					<label class="taxonomy-search">
						<Icon icon="material-symbols:search-rounded" />
						<input
							type="search"
							bind:value={taxonomySearch}
							placeholder="搜索名称"
						/>
					</label>
				</div>

				<div class="taxonomy-tabs">
					<button
						type="button"
						class:active={taxonomyKind === "category"}
						on:click={() => (taxonomyKind = "category")}
					>
						<Icon icon="material-symbols:folder-rounded" />
						分类 <strong>{categories.length}</strong>
					</button>
					<button
						type="button"
						class:active={taxonomyKind === "tag"}
						on:click={() => (taxonomyKind = "tag")}
					>
						<Icon icon="material-symbols:label-rounded" />
						标签 <strong>{tags.length}</strong>
					</button>
				</div>

				<div class="taxonomy-info">
					<Icon icon="material-symbols:info-rounded" />
					<span>
						{taxonomyKind === "category"
							? "一篇文章只能属于一个分类；删除分类后，相关文章会变为未分类。"
							: "一篇文章可以拥有多个标签；删除标签不会删除任何文章。"}
					</span>
				</div>

				<div class="taxonomy-grid">
					{#each (taxonomyKind === "category" ? categories : tags).filter( (item) => item.name
								.toLocaleLowerCase()
								.includes(taxonomySearch
										.trim()
										.toLocaleLowerCase()) ) as item (item.name)}
						<article class="taxonomy-card">
							<div class={`taxonomy-icon ${taxonomyKind}`}>
								<Icon
									icon={taxonomyKind === "category"
										? "material-symbols:folder-rounded"
										: "material-symbols:label-rounded"}
								/>
							</div>
							<div class="taxonomy-copy">
								<div>
									<strong>{item.name}</strong>
									<span>{item.count} 篇文章</span>
								</div>
								<p>{relatedPostTitles(item, taxonomyKind)}</p>
							</div>
							<div class="taxonomy-actions">
								{#if taxonomyKind === "category" && item.name === "未分类"}
									<button
										type="button"
										on:click={() => mergeTaxonomy(item)}
									>
										<Icon
											icon="material-symbols:drive-file-move-rounded"
										/>归类
									</button>
									<span class="taxonomy-system-badge"
										>系统项</span
									>
								{:else}
									<button
										type="button"
										on:click={() => renameTaxonomy(item)}
									>
										<Icon
											icon="material-symbols:edit-rounded"
										/>重命名
									</button>
									<button
										type="button"
										on:click={() => mergeTaxonomy(item)}
									>
										<Icon
											icon="material-symbols:merge-rounded"
										/>合并
									</button>
									<button
										class="danger"
										type="button"
										on:click={() => deleteTaxonomy(item)}
									>
										<Icon
											icon="material-symbols:delete-outline-rounded"
										/>删除
									</button>
								{/if}
							</div>
						</article>
					{/each}
				</div>
			</section>
		{:else if activeView === "trash"}
			<section class="panel trash-panel">
				<div class="panel-heading">
					<div>
						<p class="eyebrow">Recycle bin</p>
						<h2>文章回收站</h2>
						<span
							>恢复后统一回到草稿；永久删除需要输入文章标题确认。</span
						>
					</div>
				</div>
				{#if trashedPosts.length === 0}
					<div class="empty-state large">
						<Icon
							icon="material-symbols:delete-sweep-outline-rounded"
						/>
						<strong>回收站是空的</strong>
						<span>被移除的文章会暂时保存在这里。</span>
					</div>
				{:else}
					<div class="trash-list">
						{#each trashedPosts as post (post.id)}
							<article>
								<div class="trash-icon">
									<Icon
										icon="material-symbols:article-outline-rounded"
									/>
								</div>
								<div>
									<strong>{post.title}</strong>
									<span
										>/{post.slug} · 移除于 {formatDate(
											post.updatedAt,
										)}</span
									>
								</div>
								<button
									type="button"
									on:click={() => restorePost(post)}
								>
									<Icon
										icon="material-symbols:restore-rounded"
									/>恢复为草稿
								</button>
								<button
									class="danger"
									type="button"
									on:click={() => permanentlyDelete(post)}
								>
									<Icon
										icon="material-symbols:delete-forever-rounded"
									/>永久删除
								</button>
							</article>
						{/each}
					</div>
				{/if}
			</section>
		{/if}
	{/if}
</section>

{#if dialog.open}
	<div
		class="dialog-backdrop"
		role="presentation"
		on:click={(event) => {
			if (event.currentTarget === event.target) closeDialog();
		}}
	>
		<div
			class:danger={dialog.tone === "danger"}
			class="dialog-card"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="studio-dialog-title"
		>
			<div class="dialog-icon">
				<Icon
					icon={dialog.tone === "danger"
						? "material-symbols:warning-rounded"
						: "material-symbols:edit-rounded"}
				/>
			</div>
			<div class="dialog-copy">
				<h2 id="studio-dialog-title">{dialog.title}</h2>
				<p>{dialog.message}</p>
				{#if dialog.requiresInput}
					<label>
						<span>{dialog.inputLabel}</span>
						<input
							bind:value={dialogValue}
							placeholder={dialog.inputPlaceholder}
							on:keydown={(event) => {
								if (event.key === "Enter") submitDialog();
							}}
						/>
					</label>
				{/if}
			</div>
			<div class="dialog-actions">
				<button
					class="secondary-button"
					type="button"
					on:click={closeDialog}
				>
					取消
				</button>
				<button
					class:danger={dialog.tone === "danger"}
					class="primary-button"
					type="button"
					on:click={submitDialog}
				>
					{dialog.confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.studio-shell {
		--studio-border: color-mix(in srgb, var(--primary) 11%, transparent);
		--studio-muted: color-mix(in srgb, currentColor 66%, transparent);
	}

	button,
	input,
	textarea,
	select {
		font: inherit;
	}

	button {
		cursor: pointer;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
		transform: none !important;
	}

	.studio-shell {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: 100%;
		color: rgb(18 27 45 / 92%);
	}

	.studio-shell.embedded {
		padding-top: 0.15rem;
	}

	.studio-shell.saving {
		cursor: progress;
	}

	.studio-shell.saving > :not(.feedback-toast) {
		pointer-events: none;
	}

	:global(.dark) .studio-shell {
		color: rgb(243 247 255 / 92%);
	}

	.studio-hero,
	.panel,
	.editor-shell {
		border: 1px solid var(--studio-border);
		border-radius: 1.5rem;
		background: color-mix(in srgb, var(--card-bg) 94%, transparent);
		box-shadow: 0 1rem 3rem rgb(37 78 111 / 7%);
		backdrop-filter: blur(1.25rem);
	}

	.studio-hero {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 2rem;
		padding: 1.6rem 1.8rem;
		overflow: hidden;
		position: relative;
	}

	.studio-hero::after {
		position: absolute;
		width: 17rem;
		height: 17rem;
		right: -5rem;
		top: -8rem;
		border-radius: 50%;
		background: radial-gradient(
			circle,
			color-mix(in srgb, var(--primary) 18%, transparent),
			transparent 70%
		);
		content: "";
		pointer-events: none;
	}

	.hero-copy,
	.hero-actions {
		position: relative;
		z-index: 1;
	}

	.preview-label,
	.eyebrow {
		color: var(--primary);
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.preview-label {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		margin-bottom: 0.4rem;
		padding: 0.32rem 0.65rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		letter-spacing: 0.06em;
	}

	.preview-dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: #43b581;
		box-shadow: 0 0 0 0.25rem rgb(67 181 129 / 14%);
	}

	.studio-hero h1 {
		margin: 0;
		font-size: clamp(1.65rem, 3vw, 2.35rem);
		line-height: 1.15;
	}

	.studio-hero p {
		margin: 0.55rem 0 0;
		color: var(--studio-muted);
		font-size: 0.92rem;
	}

	.hero-actions,
	.editor-actions {
		display: flex;
		align-items: center;
		gap: 0.65rem;
	}

	.primary-button,
	.secondary-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		min-height: 2.75rem;
		padding: 0 1rem;
		border: 0;
		border-radius: 0.9rem;
		font-weight: 750;
		transition:
			transform 160ms ease,
			box-shadow 160ms ease,
			background 160ms ease;
	}

	.primary-button {
		background: linear-gradient(
			135deg,
			var(--primary),
			color-mix(in srgb, var(--primary) 64%, #8272e9)
		);
		color: white;
		box-shadow: 0 0.7rem 1.5rem
			color-mix(in srgb, var(--primary) 25%, transparent);
	}

	.primary-button:hover,
	.secondary-button:hover {
		transform: translateY(-1px);
	}

	.primary-button.danger {
		background: linear-gradient(135deg, #e85d6a, #c74354);
		box-shadow: 0 0.7rem 1.5rem rgb(232 93 106 / 22%);
	}

	.secondary-button {
		border: 1px solid var(--studio-border);
		background: color-mix(in srgb, var(--btn-regular-bg) 72%, transparent);
		color: inherit;
	}

	.primary-button :global(svg),
	.secondary-button :global(svg) {
		width: 1.1rem;
		height: 1.1rem;
	}

	.compact {
		min-height: 2.5rem;
		padding: 0 0.85rem;
	}

	.prototype-notice {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.8rem;
		padding: 0.85rem 1rem;
		border: 1px solid color-mix(in srgb, #e6ad42 30%, transparent);
		border-radius: 1rem;
		background: color-mix(in srgb, #f6c85d 10%, var(--card-bg));
	}

	.prototype-notice > :global(svg) {
		width: 1.45rem;
		height: 1.45rem;
		color: #c4871c;
	}

	.prototype-notice.live {
		border-color: color-mix(in srgb, #43b581 30%, transparent);
		background: color-mix(in srgb, #43b581 9%, var(--card-bg));
	}

	.prototype-notice.live > :global(svg),
	.prototype-notice.live .flow i {
		color: #2f9a6c;
	}

	.content-state {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.85rem;
		min-height: 14rem;
		padding: 1.5rem;
		border: 1px solid var(--studio-border);
		border-radius: 1.25rem;
		background: color-mix(in srgb, var(--card-bg) 94%, transparent);
		text-align: left;
	}

	.content-state > :global(svg) {
		width: 1.8rem;
		height: 1.8rem;
		flex: 0 0 auto;
		color: #d65464;
	}

	.content-state > div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.2rem;
	}

	.content-state span {
		color: var(--studio-muted);
		font-size: 0.78rem;
	}

	.content-state.error {
		border-color: color-mix(in srgb, #ef6a76 24%, transparent);
		background: color-mix(in srgb, #ef6a76 7%, var(--card-bg));
	}

	.content-state .secondary-button {
		margin-left: auto;
	}

	.studio-spinner {
		width: 1.3rem;
		height: 1.3rem;
		flex: 0 0 auto;
		border: 2px solid color-mix(in srgb, var(--primary) 20%, transparent);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: studio-spin 0.75s linear infinite;
	}

	.saving-badge {
		position: fixed;
		z-index: 130;
		right: 1.25rem;
		bottom: 1.25rem;
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.8rem 1rem;
		border: 1px solid color-mix(in srgb, var(--primary) 26%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--card-bg) 94%, var(--primary) 6%);
		color: var(--primary);
		font-size: 0.78rem;
		font-weight: 750;
		box-shadow: 0 1rem 2.5rem rgb(0 0 0 / 14%);
	}

	.prototype-notice > div:not(.flow) {
		display: flex;
		flex-direction: column;
		gap: 0.12rem;
	}

	.prototype-notice strong {
		font-size: 0.82rem;
	}

	.prototype-notice span {
		color: var(--studio-muted);
		font-size: 0.72rem;
	}

	.flow {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.flow span {
		padding: 0.32rem 0.55rem;
		border-radius: 999px;
		background: color-mix(in srgb, #f6c85d 15%, transparent);
		color: inherit;
		font-weight: 700;
		white-space: nowrap;
	}

	.flow i {
		color: #c4871c;
		font-style: normal;
	}

	.studio-nav {
		display: flex;
		gap: 0.35rem;
		padding: 0.4rem;
		border: 1px solid var(--studio-border);
		border-radius: 1rem;
		background: color-mix(in srgb, var(--card-bg) 92%, transparent);
	}

	.studio-nav button {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 2.65rem;
		padding: 0 0.85rem;
		border: 0;
		border-radius: 0.75rem;
		background: transparent;
		color: var(--studio-muted);
		font-weight: 700;
		transition: 160ms ease;
	}

	.studio-nav button.active {
		background: color-mix(in srgb, var(--primary) 11%, transparent);
		color: var(--primary);
	}

	.studio-nav button :global(svg) {
		width: 1.12rem;
		height: 1.12rem;
	}

	.studio-nav strong {
		display: grid;
		min-width: 1.3rem;
		height: 1.3rem;
		place-items: center;
		padding: 0 0.25rem;
		border-radius: 999px;
		background: color-mix(in srgb, currentColor 10%, transparent);
		font-size: 0.65rem;
	}

	.feedback-toast {
		position: fixed;
		z-index: 120;
		right: 1.25rem;
		bottom: 1.25rem;
		display: flex;
		align-items: center;
		gap: 0.55rem;
		max-width: min(28rem, calc(100vw - 2rem));
		padding: 0.85rem 1rem;
		border: 1px solid rgb(67 181 129 / 25%);
		border-radius: 1rem;
		background: color-mix(in srgb, #eaf9f1 92%, var(--card-bg));
		color: #267a54;
		font-size: 0.82rem;
		font-weight: 700;
		box-shadow: 0 1rem 3rem rgb(22 56 42 / 18%);
	}

	.feedback-toast.warning {
		border-color: rgb(230 173 66 / 30%);
		background: color-mix(in srgb, #fff7e5 92%, var(--card-bg));
		color: #9a6816;
	}

	.stats-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.stats-grid article {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1rem;
		border: 1px solid var(--studio-border);
		border-radius: 1.15rem;
		background: color-mix(in srgb, var(--card-bg) 92%, transparent);
	}

	.stat-icon {
		display: grid;
		width: 2.8rem;
		height: 2.8rem;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 0.9rem;
	}

	.stat-icon :global(svg) {
		width: 1.35rem;
		height: 1.35rem;
	}

	.stat-icon.published {
		background: rgb(67 181 129 / 12%);
		color: #2f9a6c;
	}

	.stat-icon.draft {
		background: rgb(242 184 75 / 15%);
		color: #be7f18;
	}

	.stat-icon.hidden {
		background: rgb(107 119 143 / 12%);
		color: #69758c;
	}

	.stat-icon.pinned {
		background: color-mix(in srgb, var(--primary) 12%, transparent);
		color: var(--primary);
	}

	.stats-grid article > div:last-child {
		display: flex;
		flex-direction: column;
	}

	.stats-grid strong {
		font-size: 1.45rem;
		line-height: 1;
	}

	.stats-grid span {
		margin-top: 0.3rem;
		color: var(--studio-muted);
		font-size: 0.7rem;
	}

	.panel {
		padding: 1.2rem;
	}

	.panel-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.panel-heading h2,
	.editor-header h2 {
		margin: 0.12rem 0 0;
		font-size: 1.2rem;
	}

	.panel-heading span {
		display: block;
		margin-top: 0.3rem;
		color: var(--studio-muted);
		font-size: 0.75rem;
	}

	.filter-toolbar {
		display: grid;
		grid-template-columns: minmax(16rem, 1fr) repeat(3, minmax(8rem, auto));
		gap: 0.55rem;
		margin-bottom: 0.8rem;
	}

	.search-field,
	.taxonomy-search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.6rem;
		padding: 0 0.75rem;
		border: 1px solid var(--studio-border);
		border-radius: 0.8rem;
		background: color-mix(in srgb, var(--btn-regular-bg) 54%, transparent);
	}

	.search-field :global(svg),
	.taxonomy-search :global(svg) {
		flex: 0 0 auto;
		color: var(--studio-muted);
	}

	.search-field input,
	.taxonomy-search input {
		width: 100%;
		border: 0;
		outline: 0;
		background: transparent;
		color: inherit;
	}

	.filter-toolbar select {
		min-height: 2.6rem;
		padding: 0 2rem 0 0.7rem;
		border: 1px solid var(--studio-border);
		border-radius: 0.8rem;
		background: color-mix(
			in srgb,
			var(--btn-regular-bg) 54%,
			var(--card-bg)
		);
		color: inherit;
		font-size: 0.76rem;
	}

	.bulk-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.65rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid color-mix(in srgb, var(--primary) 26%, transparent);
		border-radius: 0.85rem;
		background: color-mix(in srgb, var(--primary) 8%, transparent);
	}

	.bulk-toolbar > div {
		display: flex;
		align-items: center;
		gap: 0.55rem;
	}

	.bulk-toolbar strong {
		color: var(--primary);
		font-size: 0.8rem;
	}

	.bulk-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.bulk-actions button,
	.taxonomy-actions button,
	.trash-list button {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 2rem;
		padding: 0 0.55rem;
		border: 1px solid var(--studio-border);
		border-radius: 0.6rem;
		background: color-mix(in srgb, var(--card-bg) 85%, transparent);
		color: inherit;
		font-size: 0.68rem;
		font-weight: 700;
	}

	button.danger {
		color: #d34c5d;
	}

	.selection-check {
		display: grid;
		width: 1.15rem;
		height: 1.15rem;
		flex: 0 0 auto;
		place-items: center;
		padding: 0;
		border: 1.5px solid color-mix(in srgb, currentColor 22%, transparent);
		border-radius: 0.35rem;
		background: transparent;
		color: white;
	}

	.selection-check.checked {
		border-color: var(--primary);
		background: var(--primary);
	}

	.post-table {
		overflow: hidden;
		border: 1px solid var(--studio-border);
		border-radius: 1rem;
	}

	.post-table-head,
	.post-row {
		display: grid;
		grid-template-columns: 1.4rem minmax(20rem, 1fr) 7rem 8.5rem 9.5rem;
		align-items: center;
		gap: 0.7rem;
	}

	.post-table-head {
		padding: 0.65rem 0.85rem;
		background: color-mix(in srgb, var(--btn-regular-bg) 58%, transparent);
		color: var(--studio-muted);
		font-size: 0.65rem;
		font-weight: 800;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.post-row {
		padding: 0.8rem 0.85rem;
		border-top: 1px solid var(--studio-border);
		background: color-mix(in srgb, var(--card-bg) 78%, transparent);
		transition:
			background 150ms ease,
			box-shadow 150ms ease;
	}

	.post-row:hover,
	.post-row.selected {
		background: color-mix(in srgb, var(--primary) 5%, var(--card-bg));
	}

	.post-main {
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
	}

	.post-title-line {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.post-title-line strong {
		overflow: hidden;
		font-size: 0.86rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pin-icon {
		color: var(--primary);
	}

	.lock-icon {
		color: #bf8a2c;
	}

	.post-main > p {
		overflow: hidden;
		margin: 0.2rem 0 0;
		color: var(--studio-muted);
		font-size: 0.7rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.post-meta {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.42rem;
		overflow: hidden;
	}

	.post-meta span,
	.post-meta i {
		display: inline-flex;
		align-items: center;
		gap: 0.22rem;
		min-width: 0;
		padding: 0.18rem 0.36rem;
		border-radius: 0.4rem;
		background: color-mix(in srgb, var(--btn-regular-bg) 65%, transparent);
		color: var(--studio-muted);
		font-size: 0.6rem;
		font-style: normal;
		white-space: nowrap;
	}

	.post-meta span :global(svg) {
		flex: 0 0 auto;
	}

	.status-cell {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.2rem;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.25rem 0.5rem;
		border-radius: 999px;
		background: rgb(107 119 143 / 10%);
		color: #68758e;
		font-size: 0.63rem;
		font-weight: 800;
	}

	.status-badge i {
		width: 0.38rem;
		height: 0.38rem;
		border-radius: 50%;
		background: currentColor;
	}

	.status-badge.published {
		background: rgb(67 181 129 / 11%);
		color: #2f9669;
	}

	.status-badge.draft {
		background: rgb(242 184 75 / 13%);
		color: #b77917;
	}

	.status-badge.hidden {
		background: rgb(107 119 143 / 12%);
		color: #657087;
	}

	.status-cell small,
	.post-row time {
		color: var(--studio-muted);
		font-size: 0.61rem;
	}

	.row-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.25rem;
	}

	.row-actions button {
		display: grid;
		width: 2.15rem;
		height: 2.15rem;
		place-items: center;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 0.55rem;
		background: transparent;
		color: var(--studio-muted);
	}

	.row-actions button:hover,
	.row-actions button.active {
		border-color: var(--studio-border);
		background: color-mix(in srgb, var(--primary) 9%, transparent);
		color: var(--primary);
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 13rem;
		padding: 2rem;
		color: var(--studio-muted);
		text-align: center;
	}

	.empty-state.large {
		min-height: 23rem;
	}

	.empty-state > :global(svg) {
		width: 2.8rem;
		height: 2.8rem;
		margin-bottom: 0.7rem;
		color: color-mix(in srgb, var(--primary) 55%, transparent);
	}

	.empty-state strong {
		color: inherit;
		font-size: 0.9rem;
	}

	.empty-state span {
		margin-top: 0.3rem;
		font-size: 0.7rem;
	}

	.editor-shell {
		overflow: hidden;
	}

	.editor-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 1rem;
		border-bottom: 1px solid var(--studio-border);
	}

	.editor-header > div:first-child {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}

	.editor-header h2 {
		overflow: hidden;
		max-width: 34rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.back-button {
		display: grid;
		width: 2.4rem;
		height: 2.4rem;
		flex: 0 0 auto;
		place-items: center;
		border: 1px solid var(--studio-border);
		border-radius: 0.75rem;
		background: color-mix(in srgb, var(--btn-regular-bg) 55%, transparent);
		color: inherit;
	}

	.editor-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 18rem;
		min-height: 48rem;
	}

	.editor-main {
		min-width: 0;
		padding: 1.2rem;
		border-right: 1px solid var(--studio-border);
	}

	.title-editor {
		position: relative;
		margin-bottom: 1rem;
	}

	.title-input {
		width: 100%;
		padding: 0.3rem 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: inherit;
		font-size: clamp(1.55rem, 3vw, 2.3rem);
		font-weight: 850;
		line-height: 1.2;
	}

	.slug-line {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.45rem;
		color: var(--studio-muted);
		font-size: 0.68rem;
	}

	.slug-line input {
		min-width: 0;
		flex: 1;
		padding: 0.25rem 0.4rem;
		border: 1px solid transparent;
		border-radius: 0.4rem;
		outline: 0;
		background: transparent;
		color: inherit;
	}

	.slug-line input:focus {
		border-color: var(--studio-border);
		background: color-mix(in srgb, var(--btn-regular-bg) 55%, transparent);
	}

	.description-input {
		width: 100%;
		margin-top: 0.8rem;
		padding: 0.7rem 0.8rem;
		resize: vertical;
		border: 1px solid var(--studio-border);
		border-radius: 0.8rem;
		outline: 0;
		background: color-mix(in srgb, var(--btn-regular-bg) 38%, transparent);
		color: inherit;
		font-size: 0.78rem;
		line-height: 1.6;
	}

	.character-count {
		position: absolute;
		right: 0.55rem;
		bottom: 0.35rem;
		color: var(--studio-muted);
		font-size: 0.58rem;
	}

	.editor-workspace {
		overflow: hidden;
		border: 1px solid var(--studio-border);
		border-radius: 1rem;
	}

	.editor-mode-tabs {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		min-height: 2.8rem;
		padding: 0.35rem 0.45rem;
		border-bottom: 1px solid var(--studio-border);
		background: color-mix(in srgb, var(--btn-regular-bg) 42%, transparent);
	}

	.editor-mode-tabs button {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 2rem;
		padding: 0 0.55rem;
		border: 0;
		border-radius: 0.55rem;
		background: transparent;
		color: var(--studio-muted);
		font-size: 0.68rem;
		font-weight: 750;
	}

	.editor-mode-tabs button.active {
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		color: var(--primary);
	}

	.editor-mode-tabs > span {
		margin-left: auto;
		padding-right: 0.4rem;
		color: var(--studio-muted);
		font-family: ui-monospace, monospace;
		font-size: 0.62rem;
	}

	.editor-panes {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		min-height: 35rem;
	}

	.editor-panes.mode-write,
	.editor-panes.mode-preview {
		grid-template-columns: 1fr;
	}

	.markdown-editor {
		width: 100%;
		min-height: 35rem;
		padding: 1rem;
		resize: vertical;
		border: 0;
		border-right: 1px solid var(--studio-border);
		outline: 0;
		background: color-mix(in srgb, var(--card-bg) 82%, transparent);
		color: inherit;
		font-family:
			"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Consolas,
			monospace;
		font-size: 0.76rem;
		line-height: 1.8;
		tab-size: 2;
	}

	.mode-write .markdown-editor {
		border-right: 0;
	}

	.markdown-preview {
		min-width: 0;
		max-height: 48rem;
		overflow: auto;
		padding: 1rem 1.2rem;
		background: color-mix(in srgb, var(--card-bg) 74%, transparent);
		font-size: 0.82rem;
		line-height: 1.8;
	}

	.markdown-preview :global(h1),
	.markdown-preview :global(h2),
	.markdown-preview :global(h3) {
		margin: 1.1em 0 0.45em;
		line-height: 1.35;
	}

	.markdown-preview :global(h1) {
		font-size: 1.65rem;
	}

	.markdown-preview :global(h2) {
		font-size: 1.35rem;
	}

	.markdown-preview :global(h3) {
		font-size: 1.1rem;
	}

	.markdown-preview :global(p) {
		margin: 0.7em 0;
	}

	.markdown-preview :global(pre) {
		overflow: auto;
		padding: 0.8rem;
		border-radius: 0.7rem;
		background: rgb(16 24 40 / 92%);
		color: #e9f1ff;
		font-size: 0.7rem;
	}

	.markdown-preview :global(code) {
		padding: 0.1em 0.3em;
		border-radius: 0.3rem;
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		color: var(--primary);
	}

	.markdown-preview :global(pre code) {
		padding: 0;
		background: transparent;
		color: inherit;
	}

	.markdown-preview :global(blockquote) {
		margin: 0.8rem 0;
		padding: 0.4rem 0.8rem;
		border-left: 3px solid var(--primary);
		background: color-mix(in srgb, var(--primary) 7%, transparent);
		color: var(--studio-muted);
	}

	.preview-empty {
		display: grid;
		min-height: 20rem;
		place-items: center;
		color: var(--studio-muted);
	}

	.editor-sidebar {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.9rem;
		background: color-mix(in srgb, var(--btn-regular-bg) 18%, transparent);
	}

	.setting-card {
		padding: 0.85rem;
		border: 1px solid var(--studio-border);
		border-radius: 0.9rem;
		background: color-mix(in srgb, var(--card-bg) 82%, transparent);
	}

	.setting-title {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		margin-bottom: 0.8rem;
	}

	.setting-title > :global(svg) {
		width: 1.2rem;
		height: 1.2rem;
		color: var(--primary);
	}

	.setting-title > div {
		display: flex;
		flex-direction: column;
	}

	.setting-title strong {
		font-size: 0.76rem;
	}

	.setting-title span,
	.setting-card small,
	.setting-hint {
		color: var(--studio-muted);
		font-size: 0.6rem;
	}

	.setting-card label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.65rem;
	}

	.setting-card label > span,
	.dialog-copy label > span {
		font-size: 0.65rem;
		font-weight: 750;
	}

	.setting-card input,
	.setting-card select,
	.dialog-copy input {
		width: 100%;
		min-height: 2.35rem;
		padding: 0 0.65rem;
		border: 1px solid var(--studio-border);
		border-radius: 0.65rem;
		outline: 0;
		background: color-mix(in srgb, var(--btn-regular-bg) 45%, transparent);
		color: inherit;
		font-size: 0.7rem;
	}

	.setting-card select {
		appearance: auto;
	}

	.toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
		margin-top: 0.75rem;
	}

	.toggle-row > div {
		display: flex;
		flex-direction: column;
	}

	.toggle-row strong {
		font-size: 0.68rem;
	}

	.toggle-row span {
		margin-top: 0.12rem;
		color: var(--studio-muted);
		font-size: 0.58rem;
	}

	.switch {
		position: relative;
		width: 2.2rem;
		height: 1.25rem;
		flex: 0 0 auto;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: color-mix(in srgb, currentColor 15%, transparent);
		transition: 160ms ease;
	}

	.switch i {
		position: absolute;
		width: 0.9rem;
		height: 0.9rem;
		left: 0.18rem;
		top: 0.18rem;
		border-radius: 50%;
		background: white;
		box-shadow: 0 0.1rem 0.3rem rgb(0 0 0 / 20%);
		transition: 160ms ease;
	}

	.switch.on {
		background: var(--primary);
	}

	.switch.on i {
		transform: translateX(0.94rem);
	}

	.tag-input-row {
		display: flex;
		gap: 0.35rem;
	}

	.tag-input-row input {
		min-width: 0;
		flex: 1;
	}

	.tag-input-row button {
		display: grid;
		width: 2.35rem;
		flex: 0 0 auto;
		place-items: center;
		border: 0;
		border-radius: 0.65rem;
		background: color-mix(in srgb, var(--primary) 11%, transparent);
		color: var(--primary);
	}

	.tag-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: 0.55rem;
	}

	.tag-list button {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		min-height: 1.65rem;
		padding: 0 0.4rem;
		border: 0;
		border-radius: 999px;
		background: color-mix(in srgb, var(--primary) 9%, transparent);
		color: var(--primary);
		font-size: 0.6rem;
	}

	.setting-card details {
		margin-top: 0.75rem;
	}

	.setting-card summary {
		color: var(--primary);
		font-size: 0.65rem;
		font-weight: 750;
		cursor: pointer;
	}

	.danger-zone {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 2.5rem;
		border: 1px solid rgb(211 76 93 / 25%);
		border-radius: 0.75rem;
		background: rgb(211 76 93 / 7%);
		color: #d34c5d;
		font-size: 0.7rem;
		font-weight: 750;
	}

	.taxonomy-heading {
		align-items: center;
	}

	.taxonomy-search {
		width: min(18rem, 100%);
	}

	.taxonomy-tabs {
		display: flex;
		gap: 0.35rem;
		margin-bottom: 0.75rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--studio-border);
	}

	.taxonomy-tabs button {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 2.45rem;
		padding: 0 0.75rem;
		border: 0;
		border-radius: 0.7rem;
		background: transparent;
		color: var(--studio-muted);
		font-size: 0.72rem;
		font-weight: 750;
	}

	.taxonomy-tabs button.active {
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		color: var(--primary);
	}

	.taxonomy-tabs strong {
		display: grid;
		min-width: 1.25rem;
		height: 1.25rem;
		place-items: center;
		border-radius: 999px;
		background: color-mix(in srgb, currentColor 10%, transparent);
		font-size: 0.58rem;
	}

	.taxonomy-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
		padding: 0.65rem 0.75rem;
		border-radius: 0.75rem;
		background: color-mix(in srgb, var(--primary) 6%, transparent);
		color: var(--studio-muted);
		font-size: 0.67rem;
	}

	.taxonomy-info :global(svg) {
		flex: 0 0 auto;
		color: var(--primary);
	}

	.taxonomy-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem;
	}

	.taxonomy-card {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.7rem;
		padding: 0.8rem;
		border: 1px solid var(--studio-border);
		border-radius: 0.9rem;
		background: color-mix(in srgb, var(--card-bg) 82%, transparent);
	}

	.taxonomy-icon {
		display: grid;
		width: 2.5rem;
		height: 2.5rem;
		place-items: center;
		border-radius: 0.75rem;
	}

	.taxonomy-icon.category {
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		color: var(--primary);
	}

	.taxonomy-icon.tag {
		background: rgb(139 120 230 / 10%);
		color: #7969cb;
	}

	.taxonomy-copy {
		min-width: 0;
	}

	.taxonomy-copy > div {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.taxonomy-copy strong {
		overflow: hidden;
		font-size: 0.8rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.taxonomy-copy span,
	.taxonomy-copy p {
		color: var(--studio-muted);
		font-size: 0.6rem;
	}

	.taxonomy-copy p {
		overflow: hidden;
		margin: 0.3rem 0 0;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.taxonomy-actions {
		display: flex;
		gap: 0.25rem;
	}

	.taxonomy-actions button {
		padding: 0 0.45rem;
	}

	.taxonomy-system-badge {
		display: inline-flex;
		align-items: center;
		padding: 0 0.5rem;
		border-radius: 0.55rem;
		background: color-mix(in srgb, currentColor 7%, transparent);
		color: var(--studio-muted);
		font-size: 0.6rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.trash-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.trash-list article {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 0.7rem;
		padding: 0.75rem;
		border: 1px solid var(--studio-border);
		border-radius: 0.85rem;
		background: color-mix(in srgb, var(--card-bg) 82%, transparent);
	}

	.trash-icon {
		display: grid;
		width: 2.4rem;
		height: 2.4rem;
		place-items: center;
		border-radius: 0.7rem;
		background: rgb(107 119 143 / 10%);
		color: #707b90;
	}

	.trash-list article > div:nth-child(2) {
		display: flex;
		min-width: 0;
		flex-direction: column;
	}

	.trash-list strong {
		overflow: hidden;
		font-size: 0.78rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trash-list span {
		margin-top: 0.2rem;
		color: var(--studio-muted);
		font-size: 0.6rem;
	}

	.dialog-backdrop {
		position: fixed;
		z-index: 200;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: rgb(9 18 35 / 48%);
		backdrop-filter: blur(0.45rem);
	}

	.dialog-card {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.8rem;
		width: min(29rem, 100%);
		padding: 1.1rem;
		border: 1px solid var(--studio-border);
		border-radius: 1.2rem;
		background: var(--card-bg);
		box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 30%);
		color: rgb(18 27 45 / 92%);
	}

	:global(.dark) .dialog-card {
		color: rgb(243 247 255 / 92%);
	}

	.dialog-icon {
		display: grid;
		width: 2.7rem;
		height: 2.7rem;
		place-items: center;
		border-radius: 0.85rem;
		background: color-mix(in srgb, var(--primary) 11%, transparent);
		color: var(--primary);
	}

	.dialog-card.danger .dialog-icon {
		background: rgb(211 76 93 / 10%);
		color: #d34c5d;
	}

	.dialog-copy h2 {
		margin: 0;
		font-size: 1rem;
	}

	.dialog-copy p {
		margin: 0.4rem 0 0;
		color: var(--studio-muted);
		font-size: 0.72rem;
		line-height: 1.6;
	}

	.dialog-copy label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.8rem;
	}

	.dialog-actions {
		grid-column: 1 / -1;
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding-top: 0.35rem;
	}

	.panel-heading > div > span,
	.post-copy p,
	.post-meta span,
	.status-badge,
	.status-cell small,
	.post-row time,
	.character-count,
	.setting-title span,
	.setting-card small,
	.setting-hint,
	.setting-card label > span,
	.dialog-copy label > span,
	.taxonomy-copy span,
	.taxonomy-copy p,
	.taxonomy-system-badge,
	.trash-list article span {
		font-size: 0.72rem;
		line-height: 1.45;
	}

	@keyframes studio-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 1100px) {
		.post-table-head,
		.post-row {
			grid-template-columns: 1.4rem minmax(17rem, 1fr) 6.5rem 8rem;
		}

		.post-table-head span:last-child,
		.post-row time {
			display: none;
		}

		.editor-layout {
			grid-template-columns: 1fr;
		}

		.editor-main {
			border-right: 0;
			border-bottom: 1px solid var(--studio-border);
		}

		.editor-sidebar {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.danger-zone {
			grid-column: 1 / -1;
		}

		.taxonomy-card {
			grid-template-columns: auto minmax(0, 1fr);
		}

		.taxonomy-actions {
			grid-column: 1 / -1;
			justify-content: flex-end;
		}
	}

	@media (max-width: 760px) {
		.studio-hero,
		.panel-heading,
		.editor-header,
		.bulk-toolbar,
		.taxonomy-heading {
			align-items: stretch;
			flex-direction: column;
		}

		.hero-actions,
		.editor-actions {
			width: 100%;
		}

		.hero-actions button,
		.editor-actions button {
			flex: 1;
		}

		.prototype-notice {
			grid-template-columns: auto minmax(0, 1fr);
		}

		.flow {
			display: none;
		}

		.studio-nav {
			overflow-x: auto;
			scrollbar-width: none;
		}

		.studio-nav::-webkit-scrollbar {
			display: none;
		}

		.studio-nav button {
			flex: 0 0 auto;
		}

		.stats-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.filter-toolbar {
			grid-template-columns: 1fr 1fr;
		}

		.search-field {
			grid-column: 1 / -1;
		}

		.bulk-actions {
			justify-content: flex-start;
		}

		.post-table-head {
			display: none;
		}

		.post-row {
			grid-template-columns: auto minmax(0, 1fr);
			align-items: start;
			gap: 0.6rem;
			padding: 0.85rem;
		}

		.post-row:first-of-type {
			border-top: 0;
		}

		.status-cell {
			grid-column: 2;
			flex-direction: row;
			align-items: center;
		}

		.row-actions {
			grid-column: 2;
			justify-content: flex-start;
		}

		.row-actions button {
			width: 2.5rem;
			height: 2.5rem;
		}

		.editor-main {
			padding: 0.85rem;
		}

		.editor-panes {
			grid-template-columns: 1fr;
		}

		.mode-split .markdown-editor {
			min-height: 22rem;
			border-right: 0;
			border-bottom: 1px solid var(--studio-border);
		}

		.editor-sidebar {
			grid-template-columns: 1fr;
		}

		.taxonomy-grid {
			grid-template-columns: 1fr;
		}

		.taxonomy-search {
			width: 100%;
		}

		.trash-list article {
			grid-template-columns: auto minmax(0, 1fr);
		}

		.trash-list article button {
			grid-column: 2;
			justify-self: start;
		}
	}

	@media (max-width: 480px) {
		.studio-hero {
			padding: 1.2rem;
		}

		.filter-toolbar {
			grid-template-columns: 1fr;
		}

		.search-field {
			grid-column: auto;
		}

		.panel {
			padding: 0.8rem;
		}

		.editor-actions {
			flex-direction: column;
		}

		.taxonomy-tabs {
			overflow-x: auto;
			scrollbar-width: none;
		}

		.taxonomy-tabs::-webkit-scrollbar {
			display: none;
		}
	}
</style>
