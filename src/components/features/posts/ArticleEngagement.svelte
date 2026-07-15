<script lang="ts">
	import Icon from "@iconify/svelte";
	import { onDestroy, onMount } from "svelte";

	import {
		getPostSnapshot,
		isBlogApiConfigured,
		recordPostShare,
		recordPostView,
		submitPostComment,
		togglePostLike,
		type BlogComment,
		type BlogMetrics,
		type BlogMutationResult,
		type ShareMethod,
	} from "@/lib/supabase";

	export let postKey: string;
	export let title: string;
	export let canonicalPath: string;
	export let canonicalUrl: string;
	export let commentsEnabled = true;

	type ServiceState = "loading" | "ready" | "unavailable";
	type FeedbackKind = "success" | "error" | "info";

	const VISITOR_ID_KEY = "mika-blog:visitor-id";
	const SESSION_ID_KEY = "mika-blog:session-id";
	const COMMENT_NAME_KEY = "mika-blog:comment-name";
	const VIEW_MARKER_PREFIX = "mika-blog:viewed:";

	let serviceState: ServiceState = "loading";
	let serviceMessage = "正在连接互动服务…";
	let metrics: BlogMetrics = { views: 0, likes: 0, shares: 0 };
	let liked = false;
	let comments: BlogComment[] = [];
	let visitorId = "";
	let sessionId = "";
	let liking = false;
	let sharing = false;
	let submitting = false;
	let authorName = "";
	let commentContent = "";
	let feedback = "";
	let feedbackKind: FeedbackKind = "info";
	let feedbackTimer: number | undefined;
	let mounted = false;
	const controllers = new Set<AbortController>();

	const countFormatter = new Intl.NumberFormat("zh-CN", {
		maximumFractionDigits: 0,
	});

	function createUuid(): string {
		if (typeof crypto !== "undefined" && crypto.randomUUID) {
			return crypto.randomUUID();
		}

		return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
			/[xy]/g,
			(character) => {
				const random = Math.floor(Math.random() * 16);
				const value = character === "x" ? random : (random & 0x3) | 0x8;
				return value.toString(16);
			},
		);
	}

	function readStorage(storage: Storage, key: string): string {
		try {
			return storage.getItem(key) || "";
		} catch {
			return "";
		}
	}

	function writeStorage(storage: Storage, key: string, value: string) {
		try {
			storage.setItem(key, value);
		} catch {
			// Storage can be unavailable in strict privacy modes.
		}
	}

	function removeStorage(storage: Storage, key: string) {
		try {
			storage.removeItem(key);
		} catch {
			// Storage can be unavailable in strict privacy modes.
		}
	}

	function getOrCreateId(storage: Storage, key: string): string {
		const stored = readStorage(storage, key);
		if (stored) {
			return stored;
		}

		const id = createUuid();
		writeStorage(storage, key, id);
		return id;
	}

	function isAbortError(error: unknown): boolean {
		return error instanceof DOMException && error.name === "AbortError";
	}

	async function runRequest<T>(
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const controller = new AbortController();
		controllers.add(controller);
		try {
			return await operation(controller.signal);
		} finally {
			controllers.delete(controller);
		}
	}

	function applyMutation(result: BlogMutationResult) {
		if (!mounted) {
			return;
		}
		if (result.metrics) {
			metrics = result.metrics;
		}
		if (result.liked !== undefined) {
			liked = result.liked;
		}
		if (result.comment) {
			comments = [result.comment, ...comments];
		}
	}

	function showFeedback(
		message: string,
		kind: FeedbackKind = "info",
		duration = 3200,
	) {
		feedback = message;
		feedbackKind = kind;
		if (feedbackTimer) {
			window.clearTimeout(feedbackTimer);
		}
		feedbackTimer = window.setTimeout(() => {
			feedback = "";
			feedbackTimer = undefined;
		}, duration);
	}

	async function registerViewOnce() {
		const markerKey = `${VIEW_MARKER_PREFIX}${encodeURIComponent(postKey)}`;
		const marker = readStorage(sessionStorage, markerKey);
		if (marker === "pending" || marker === "done") {
			return;
		}

		writeStorage(sessionStorage, markerKey, "pending");
		try {
			const result = await runRequest((signal) =>
				recordPostView(
					{
						postKey,
						visitorId,
						sessionId,
						path: canonicalPath || window.location.pathname,
						title,
					},
					signal,
				),
			);
			applyMutation(result);
			writeStorage(sessionStorage, markerKey, "done");
		} catch (error) {
			removeStorage(sessionStorage, markerKey);
			if (!isAbortError(error) && mounted) {
				serviceMessage = "互动已加载，本次浏览记录暂未同步。";
			}
		}
	}

	async function initialize() {
		if (!isBlogApiConfigured) {
			serviceState = "unavailable";
			serviceMessage = "互动服务尚未配置，文章阅读与分享不受影响。";
			return;
		}

		try {
			const snapshot = await runRequest((signal) =>
				getPostSnapshot(postKey, visitorId, signal),
			);
			if (!mounted) {
				return;
			}
			metrics = snapshot.metrics;
			liked = snapshot.liked;
			comments = snapshot.comments;
			serviceState = "ready";
			serviceMessage = "";
			await registerViewOnce();
		} catch (error) {
			if (isAbortError(error) || !mounted) {
				return;
			}
			serviceState = "unavailable";
			serviceMessage = "互动服务暂时不可用，文章阅读与分享不受影响。";
		}
	}

	async function handleLike() {
		if (liking || serviceState !== "ready") {
			return;
		}

		liking = true;
		try {
			const result = await runRequest((signal) =>
				togglePostLike({ postKey, visitorId }, signal),
			);
			applyMutation(result);
			showFeedback(
				(result.liked ?? liked) ? "谢谢你的喜欢！" : "已取消点赞。",
				"success",
			);
		} catch (error) {
			if (!isAbortError(error)) {
				showFeedback("点赞暂未同步，请稍后再试。", "error");
			}
		} finally {
			liking = false;
		}
	}

	async function trackShare(method: ShareMethod) {
		if (!isBlogApiConfigured || serviceState === "unavailable") {
			return;
		}

		try {
			const result = await runRequest((signal) =>
				recordPostShare(
					{
						postKey,
						visitorId,
						method,
						path: canonicalPath || window.location.pathname,
					},
					signal,
				),
			);
			applyMutation(result);
		} catch (error) {
			if (!isAbortError(error)) {
				serviceMessage = "分享已完成，统计将在服务恢复后更新。";
			}
		}
	}

	async function copyLink(): Promise<boolean> {
		const targetUrl = canonicalUrl || window.location.href;
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(targetUrl);
			return true;
		}

		const textarea = document.createElement("textarea");
		textarea.value = targetUrl;
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);
		textarea.select();
		const copied = document.execCommand("copy");
		textarea.remove();
		return copied;
	}

	async function handleCopyLink() {
		if (sharing) {
			return;
		}

		sharing = true;
		try {
			const copied = await copyLink();
			if (!copied) {
				throw new Error("Copy failed");
			}
			showFeedback("文章链接已复制。", "success");
			await trackShare("copy-link");
		} catch {
			showFeedback("复制失败，请从地址栏手动复制链接。", "error");
		} finally {
			sharing = false;
		}
	}

	async function handleWebShare() {
		if (sharing) {
			return;
		}

		if (!navigator.share) {
			await handleCopyLink();
			return;
		}

		sharing = true;
		try {
			await navigator.share({
				title,
				text: `分享文章：${title}`,
				url: canonicalUrl || window.location.href,
			});
			showFeedback("感谢分享这篇文章！", "success");
			await trackShare("web-share");
		} catch (error) {
			if (!isAbortError(error)) {
				showFeedback("分享没有完成，请稍后再试。", "error");
			}
		} finally {
			sharing = false;
		}
	}

	async function handleCommentSubmit() {
		if (submitting || serviceState !== "ready") {
			return;
		}

		const normalizedName = authorName.trim();
		const normalizedContent = commentContent.trim();
		if (normalizedName.length < 2 || normalizedName.length > 40) {
			showFeedback("昵称长度需为 2—40 个字符。", "error");
			return;
		}
		if (normalizedContent.length < 2 || normalizedContent.length > 2000) {
			showFeedback("评论内容需为 2—2000 个字符。", "error");
			return;
		}

		submitting = true;
		try {
			const result = await runRequest((signal) =>
				submitPostComment(
					{
						postKey,
						visitorId,
						authorName: normalizedName,
						content: normalizedContent,
					},
					signal,
				),
			);
			applyMutation(result);
			writeStorage(localStorage, COMMENT_NAME_KEY, normalizedName);
			commentContent = "";
			showFeedback(
				"评论已提交，审核通过后会显示在这里。",
				"success",
				5200,
			);
		} catch (error) {
			if (!isAbortError(error)) {
				showFeedback("评论提交失败，请稍后再试。", "error");
			}
		} finally {
			submitting = false;
		}
	}

	function formatMetric(value: number): string {
		if (serviceState === "loading") {
			return "…";
		}
		if (serviceState === "unavailable") {
			return "—";
		}
		return countFormatter.format(value);
	}

	function formatCommentDate(value: string): string {
		if (!value) {
			return "";
		}
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return "";
		}
		return new Intl.DateTimeFormat("zh-CN", {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	}

	onMount(() => {
		mounted = true;
		visitorId = getOrCreateId(localStorage, VISITOR_ID_KEY);
		sessionId = getOrCreateId(sessionStorage, SESSION_ID_KEY);
		authorName = readStorage(localStorage, COMMENT_NAME_KEY);
		void initialize();
	});

	onDestroy(() => {
		mounted = false;
		controllers.forEach((controller) => controller.abort());
		controllers.clear();
		if (feedbackTimer) {
			window.clearTimeout(feedbackTimer);
		}
	});
</script>

<section
	class="article-engagement card-base mb-4 p-5 sm:p-6 onload-animation"
	aria-labelledby="article-engagement-title"
>
	<header class="engagement-header">
		<div>
			<h2 id="article-engagement-title">文章互动</h2>
			<p>感谢阅读，也欢迎留下你的想法。</p>
		</div>
		<span class="service-dot" class:online={serviceState === "ready"}>
			{serviceState === "ready" ? "互动已连接" : "访客模式"}
		</span>
	</header>

	<div class="metrics" aria-label="文章互动统计">
		<div class="metric-item">
			<Icon icon="material-symbols:visibility-outline-rounded" />
			<strong>{formatMetric(metrics.views)}</strong>
			<span>浏览</span>
		</div>
		<button
			type="button"
			class="metric-item metric-button"
			class:active={liked}
			disabled={liking || serviceState !== "ready"}
			on:click={handleLike}
			aria-pressed={liked}
			aria-label={liked ? "取消点赞" : "点赞这篇文章"}
		>
			<Icon
				icon={liked
					? "material-symbols:favorite-rounded"
					: "material-symbols:favorite-outline-rounded"}
			/>
			<strong>{formatMetric(metrics.likes)}</strong>
			<span>{liking ? "同步中" : liked ? "已点赞" : "点赞"}</span>
		</button>
		<div class="metric-item">
			<Icon icon="material-symbols:share-outline-rounded" />
			<strong>{formatMetric(metrics.shares)}</strong>
			<span>分享</span>
		</div>
	</div>

	<div class="share-actions">
		<button
			type="button"
			class="action-button primary-action"
			disabled={sharing}
			on:click={handleWebShare}
		>
			<Icon icon="material-symbols:ios-share-rounded" />
			<span>{sharing ? "处理中…" : "分享文章"}</span>
		</button>
		<button
			type="button"
			class="action-button"
			disabled={sharing}
			on:click={handleCopyLink}
		>
			<Icon icon="material-symbols:link-rounded" />
			<span>复制链接</span>
		</button>
	</div>

	{#if serviceMessage}
		<p class="service-message" role="status">{serviceMessage}</p>
	{/if}

	{#if feedback}
		<div
			class="feedback"
			class:success={feedbackKind === "success"}
			class:error={feedbackKind === "error"}
			role="status"
			aria-live="polite"
		>
			{feedback}
		</div>
	{/if}

	{#if commentsEnabled}
		<div class="section-divider"></div>

		<section class="comments" aria-labelledby="comments-title">
			<div class="comments-heading">
				<div>
					<h3 id="comments-title">评论</h3>
					<p>已通过审核的评论会公开显示。</p>
				</div>
				<span
					>{serviceState === "ready" ? comments.length : "—"} 条</span
				>
			</div>

			{#if serviceState === "loading"}
				<div class="comments-placeholder">正在加载评论…</div>
			{:else if serviceState === "unavailable"}
				<div class="comments-placeholder">
					评论服务暂不可用，请稍后再来看看。
				</div>
			{:else if comments.length === 0}
				<div class="comments-placeholder">
					还没有公开评论，来留下第一条吧。
				</div>
			{:else}
				<div class="comment-list">
					{#each comments as comment (comment.id)}
						<article class="comment-item">
							<div class="comment-avatar" aria-hidden="true">
								{comment.authorName.slice(0, 1).toUpperCase()}
							</div>
							<div class="comment-body">
								<div class="comment-meta">
									<strong>{comment.authorName}</strong>
									{#if formatCommentDate(comment.createdAt)}
										<time datetime={comment.createdAt}
											>{formatCommentDate(
												comment.createdAt,
											)}</time
										>
									{/if}
								</div>
								<p>{comment.content}</p>
							</div>
						</article>
					{/each}
				</div>
			{/if}

			<form
				class="comment-form"
				on:submit|preventDefault={handleCommentSubmit}
			>
				<label for={`comment-name-${postKey}`}>昵称</label>
				<input
					id={`comment-name-${postKey}`}
					type="text"
					bind:value={authorName}
					minlength="2"
					maxlength="40"
					placeholder="怎么称呼你？"
					autocomplete="nickname"
					disabled={serviceState !== "ready" || submitting}
					required
				/>
				<label for={`comment-content-${postKey}`}>评论内容</label>
				<textarea
					id={`comment-content-${postKey}`}
					bind:value={commentContent}
					minlength="2"
					maxlength="2000"
					rows="5"
					placeholder="友善交流，分享你的想法……"
					disabled={serviceState !== "ready" || submitting}
					required
				></textarea>
				<div class="form-footer">
					<p>匿名评论无需登录，提交后将进入审核队列。</p>
					<button
						type="submit"
						class="submit-button"
						disabled={serviceState !== "ready" || submitting}
					>
						<Icon icon="material-symbols:send-rounded" />
						<span>{submitting ? "提交中…" : "提交评论"}</span>
					</button>
				</div>
			</form>
		</section>
	{/if}
</section>

<style>
	.article-engagement {
		position: relative;
		overflow: hidden;
	}

	.article-engagement::before {
		position: absolute;
		top: 0;
		left: 1.5rem;
		width: 4rem;
		height: 0.2rem;
		border-radius: 999px;
		background: linear-gradient(90deg, var(--primary), transparent);
		content: "";
	}

	.engagement-header,
	.comments-heading,
	.form-footer,
	.comment-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	h2,
	h3,
	p {
		margin: 0;
	}

	h2 {
		font-size: 1.25rem;
		font-weight: 800;
		color: var(--text-90, rgb(0 0 0 / 90%));
	}

	:global(.dark) h2,
	:global(.dark) h3 {
		color: rgb(255 255 255 / 90%);
	}

	.engagement-header p,
	.comments-heading p,
	.form-footer p,
	.service-message {
		margin-top: 0.25rem;
		font-size: 0.8rem;
		line-height: 1.5;
		color: rgb(0 0 0 / 50%);
	}

	:global(.dark) .engagement-header p,
	:global(.dark) .comments-heading p,
	:global(.dark) .form-footer p,
	:global(.dark) .service-message {
		color: rgb(255 255 255 / 50%);
	}

	.service-dot {
		flex: none;
		padding: 0.3rem 0.65rem;
		border-radius: 999px;
		background: var(--btn-regular-bg);
		font-size: 0.72rem;
		font-weight: 700;
		color: rgb(0 0 0 / 45%);
	}

	.service-dot.online {
		background: color-mix(in srgb, var(--primary) 14%, transparent);
		color: var(--primary);
	}

	:global(.dark) .service-dot {
		color: rgb(255 255 255 / 50%);
	}

	:global(.dark) .service-dot.online {
		color: color-mix(in srgb, var(--primary) 80%, white);
	}

	.metrics {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.75rem;
		margin-top: 1.25rem;
	}

	.metric-item {
		display: grid;
		grid-template-columns: auto auto;
		grid-template-rows: auto auto;
		align-items: center;
		justify-content: center;
		column-gap: 0.45rem;
		min-height: 5rem;
		padding: 0.8rem;
		border: 1px solid transparent;
		border-radius: 0.9rem;
		background: var(--btn-regular-bg);
		color: rgb(0 0 0 / 70%);
		text-align: left;
	}

	.metric-item :global(svg) {
		grid-row: 1 / 3;
		width: 1.5rem;
		height: 1.5rem;
		color: var(--primary);
	}

	.metric-item strong {
		font-size: 1.05rem;
		line-height: 1;
	}

	.metric-item span {
		font-size: 0.72rem;
		color: rgb(0 0 0 / 45%);
	}

	:global(.dark) .metric-item {
		color: rgb(255 255 255 / 78%);
	}

	:global(.dark) .metric-item span {
		color: rgb(255 255 255 / 45%);
	}

	.metric-button {
		font: inherit;
		cursor: pointer;
		transition:
			transform 180ms ease,
			border-color 180ms ease,
			background-color 180ms ease;
	}

	.metric-button:not(:disabled):hover {
		transform: translateY(-2px);
		border-color: color-mix(in srgb, var(--primary) 40%, transparent);
	}

	.metric-button.active {
		border-color: color-mix(in srgb, #f15b87 50%, transparent);
		background: color-mix(in srgb, #f15b87 12%, var(--btn-regular-bg));
	}

	.metric-button.active :global(svg) {
		color: #f15b87;
	}

	button:disabled,
	input:disabled,
	textarea:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.share-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.7rem;
		margin-top: 0.9rem;
	}

	.action-button,
	.submit-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 2.55rem;
		padding: 0.55rem 1rem;
		border: 0;
		border-radius: 0.75rem;
		background: var(--btn-regular-bg);
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		color: rgb(0 0 0 / 68%);
		cursor: pointer;
		transition:
			transform 180ms ease,
			background-color 180ms ease;
	}

	.action-button:not(:disabled):hover,
	.submit-button:not(:disabled):hover {
		transform: translateY(-1px);
	}

	.action-button :global(svg),
	.submit-button :global(svg) {
		width: 1.2rem;
		height: 1.2rem;
	}

	.primary-action,
	.submit-button {
		background: var(--primary);
		color: white;
	}

	:global(.dark) .action-button:not(.primary-action) {
		color: rgb(255 255 255 / 72%);
	}

	.service-message {
		margin-top: 0.8rem;
	}

	.feedback {
		margin-top: 0.8rem;
		padding: 0.7rem 0.85rem;
		border-radius: 0.7rem;
		background: var(--btn-regular-bg);
		font-size: 0.82rem;
		color: rgb(0 0 0 / 60%);
	}

	.feedback.success {
		background: color-mix(in srgb, #2ba471 13%, transparent);
		color: #168657;
	}

	.feedback.error {
		background: color-mix(in srgb, #e05252 13%, transparent);
		color: #c43f3f;
	}

	:global(.dark) .feedback:not(.success, .error) {
		color: rgb(255 255 255 / 60%);
	}

	.section-divider {
		margin: 1.4rem 0;
		border-top: 1px dashed var(--line-divider);
	}

	.comments-heading h3 {
		font-size: 1.05rem;
		font-weight: 800;
	}

	.comments-heading > span {
		flex: none;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--primary);
	}

	.comments-placeholder {
		margin-top: 1rem;
		padding: 1.15rem;
		border-radius: 0.8rem;
		background: var(--btn-regular-bg);
		font-size: 0.82rem;
		color: rgb(0 0 0 / 45%);
		text-align: center;
	}

	:global(.dark) .comments-placeholder {
		color: rgb(255 255 255 / 45%);
	}

	.comment-list {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
		margin-top: 1rem;
	}

	.comment-item {
		display: flex;
		gap: 0.75rem;
		padding: 0.9rem;
		border-radius: 0.85rem;
		background: var(--btn-regular-bg);
	}

	.comment-avatar {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		background: color-mix(in srgb, var(--primary) 16%, transparent);
		font-size: 0.85rem;
		font-weight: 800;
		color: var(--primary);
	}

	.comment-body {
		min-width: 0;
		flex: 1;
	}

	.comment-meta {
		align-items: baseline;
	}

	.comment-meta strong {
		font-size: 0.84rem;
		color: rgb(0 0 0 / 75%);
	}

	.comment-meta time {
		font-size: 0.68rem;
		color: rgb(0 0 0 / 38%);
	}

	.comment-body > p {
		margin-top: 0.35rem;
		font-size: 0.84rem;
		line-height: 1.7;
		color: rgb(0 0 0 / 62%);
		white-space: pre-wrap;
		word-break: break-word;
	}

	:global(.dark) .comment-meta strong {
		color: rgb(255 255 255 / 78%);
	}

	:global(.dark) .comment-meta time {
		color: rgb(255 255 255 / 38%);
	}

	:global(.dark) .comment-body > p {
		color: rgb(255 255 255 / 62%);
	}

	.comment-form {
		display: grid;
		gap: 0.5rem;
		margin-top: 1.2rem;
	}

	.comment-form label {
		margin-top: 0.25rem;
		font-size: 0.78rem;
		font-weight: 700;
		color: rgb(0 0 0 / 60%);
	}

	.comment-form input,
	.comment-form textarea {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid transparent;
		border-radius: 0.75rem;
		outline: none;
		background: var(--btn-regular-bg);
		font: inherit;
		font-size: 0.86rem;
		line-height: 1.6;
		color: rgb(0 0 0 / 75%);
		transition:
			border-color 180ms ease,
			box-shadow 180ms ease;
	}

	.comment-form input {
		height: 2.65rem;
		padding: 0 0.85rem;
	}

	.comment-form textarea {
		min-height: 7rem;
		padding: 0.75rem 0.85rem;
		resize: vertical;
	}

	.comment-form input:focus,
	.comment-form textarea:focus {
		border-color: color-mix(in srgb, var(--primary) 55%, transparent);
		box-shadow: 0 0 0 3px
			color-mix(in srgb, var(--primary) 12%, transparent);
	}

	:global(.dark) .comment-form label {
		color: rgb(255 255 255 / 60%);
	}

	:global(.dark) .comment-form input,
	:global(.dark) .comment-form textarea {
		color: rgb(255 255 255 / 78%);
	}

	.form-footer {
		align-items: flex-start;
		margin-top: 0.35rem;
	}

	.submit-button {
		flex: none;
	}

	@media (max-width: 520px) {
		.engagement-header,
		.form-footer {
			align-items: flex-start;
			flex-direction: column;
		}

		.metrics {
			gap: 0.45rem;
		}

		.metric-item {
			grid-template-columns: 1fr;
			grid-template-rows: auto auto auto;
			justify-items: center;
			gap: 0.2rem;
			min-height: 5.6rem;
			padding: 0.6rem 0.35rem;
			text-align: center;
		}

		.metric-item :global(svg) {
			grid-row: auto;
		}

		.share-actions,
		.action-button,
		.submit-button {
			width: 100%;
		}

		.comment-meta {
			align-items: flex-start;
			flex-direction: column;
			gap: 0.15rem;
		}
	}
</style>
