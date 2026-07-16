<script lang="ts">
	import Icon from "@iconify/svelte";
	import type { Session } from "@supabase/supabase-js";
	import { onDestroy, onMount } from "svelte";

	import {
		AdminApiError,
		type AdminAuditItem,
		type AdminComment,
		type AdminCommentCounts,
		type AdminCommentFilter,
		type AdminMe,
		type AdminModerationDecision,
		type AdminOverview,
		getAdminAuditLog,
		getAdminComments,
		getAdminMe,
		getAdminOverview,
		getSupabaseBrowserClient,
		isAdminApiConfigured,
		isSupabaseBrowserConfigured,
		moderateAdminComment,
	} from "@/lib/supabase";

	import AdminContentStudio from "./content/AdminContentStudio.svelte";
	import DonutGauge from "./DonutGauge.svelte";
	import LatencyChart from "./LatencyChart.svelte";

	type AuthState =
		"loading" | "signed-out" | "checking" | "ready" | "denied" | "error";
	type AdminTab = "operations" | "dashboard" | "content";
	type FeedbackKind = "success" | "error" | "info";

	const EMPTY_COUNTS: AdminCommentCounts = {
		pending: 0,
		approved: 0,
		rejected: 0,
		spam: 0,
		all: 0,
	};
	const FILTERS: Array<{
		value: AdminCommentFilter;
		label: string;
		icon: string;
	}> = [
		{
			value: "pending",
			label: "待审核",
			icon: "material-symbols:pending-actions-rounded",
		},
		{
			value: "approved",
			label: "已通过",
			icon: "material-symbols:check-circle-rounded",
		},
		{
			value: "rejected",
			label: "已拒绝",
			icon: "material-symbols:cancel-rounded",
		},
		{
			value: "spam",
			label: "垃圾评论",
			icon: "material-symbols:report-rounded",
		},
		{
			value: "all",
			label: "全部",
			icon: "material-symbols:forum-rounded",
		},
	];

	let authState: AuthState = "loading";
	let authMessage = "正在检查管理员身份…";
	let session: Session | null = null;
	let me: AdminMe | null = null;
	let activeTab: AdminTab = "operations";
	let overview: AdminOverview | null = null;
	let comments: AdminComment[] = [];
	let commentCounts: AdminCommentCounts = { ...EMPTY_COUNTS };
	let commentFilter: AdminCommentFilter = "pending";
	let auditEntries: AdminAuditItem[] = [];
	let loadingOverview = false;
	let loadingComments = false;
	let loadingAudit = false;
	let signingIn = false;
	let moderatingId = "";
	let browserRttMs: number | null = null;
	let feedback = "";
	let feedbackKind: FeedbackKind = "info";
	let feedbackTimer: number | undefined;
	let refreshTimer: number | undefined;
	let disposed = false;
	let authVersion = 0;
	let activeController: AbortController | null = null;
	let authSubscription: { unsubscribe: () => void } | null = null;

	$: serviceRows = overview
		? [
				{
					key: "site",
					name: "网站页面",
					description: "GitHub Pages · 网页往返探测",
					icon: "material-symbols:language",
					probe: overview.services.site,
					uptime: overview.uptime24h.site,
					p95: overview.p95Latency24h.site,
				},
				{
					key: "blogApi",
					name: "博客互动接口",
					description: "Supabase 边缘函数 · 健康查询与数据库读取",
					icon: "material-symbols:cloud-done-rounded",
					probe: overview.services.blogApi,
					uptime: overview.uptime24h.blogApi,
					p95: overview.p95Latency24h.blogApi,
				},
				{
					key: "database",
					name: "内容数据库",
					description: "Supabase · 数据库实时查询",
					icon: "material-symbols:database",
					probe: overview.services.database,
					uptime: overview.uptime24h.database,
					p95: overview.p95Latency24h.database,
				},
			]
		: [];
	$: commentTotal =
		commentCounts.pending +
		commentCounts.approved +
		commentCounts.rejected +
		commentCounts.spam;
	$: commentPieStyle = buildPieStyle(
		[
			commentCounts.approved,
			commentCounts.pending,
			commentCounts.rejected,
			commentCounts.spam,
		],
		["#43b581", "#f2b84b", "#ef6a76", "#8792a2"],
	);
	$: contentPieStyle = overview
		? buildPieStyle(
				[overview.content.articles, overview.content.diaries],
				["var(--primary)", "#8b78e6"],
			)
		: "background: var(--btn-regular-bg);";
	$: siteHistory =
		overview?.history.filter((item) => item.service === "site") ?? [];
	$: apiHistory =
		overview?.history.filter((item) => item.service === "blog-api") ?? [];

	function showFeedback(
		message: string,
		kind: FeedbackKind = "info",
		duration = 3600,
	) {
		feedback = message;
		feedbackKind = kind;
		if (feedbackTimer) window.clearTimeout(feedbackTimer);
		feedbackTimer = window.setTimeout(() => {
			feedback = "";
			feedbackTimer = undefined;
		}, duration);
	}

	function readableError(error: unknown): string {
		if (error instanceof AdminApiError) return error.message;
		if (error instanceof Error && error.message) return error.message;
		return "管理员服务暂时不可用。";
	}

	function buildPieStyle(values: number[], colors: string[]): string {
		const total = values.reduce(
			(sum, value) => sum + Math.max(0, Number(value) || 0),
			0,
		);
		if (total <= 0) return "background: var(--btn-regular-bg);";

		let cursor = 0;
		const segments = values.map((value, index) => {
			const start = cursor;
			cursor += (Math.max(0, Number(value) || 0) / total) * 100;
			return `${colors[index]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
		});
		return `background: conic-gradient(${segments.join(", ")});`;
	}

	function formatNumber(value: number | null | undefined): string {
		if (value === null || value === undefined || !Number.isFinite(value)) {
			return "暂无";
		}
		return new Intl.NumberFormat("zh-CN").format(value);
	}

	function formatBytes(value: number | null | undefined): string {
		if (value === null || value === undefined || !Number.isFinite(value)) {
			return "暂无";
		}
		const units = ["B", "KB", "MB", "GB", "TB"];
		let current = Math.max(0, value);
		let unit = 0;
		while (current >= 1024 && unit < units.length - 1) {
			current /= 1024;
			unit += 1;
		}
		return `${current.toFixed(unit === 0 ? 0 : current >= 10 ? 1 : 2)} ${units[unit]}`;
	}

	function formatLatency(value: number | null | undefined): string {
		if (value === null || value === undefined || !Number.isFinite(value)) {
			return "暂无";
		}
		return `${Math.round(value)} ms`;
	}

	function formatPercent(value: number | null | undefined): string {
		if (value === null || value === undefined || !Number.isFinite(value)) {
			return "暂无";
		}
		return `${value.toFixed(2)}%`;
	}

	function monitoringMetric(
		value: number | null | undefined,
		kind: "percent" | "latency",
	): string {
		if (!overview) return "等待采样";
		if (overview.monitoring24h.stale) return "监控中断";
		if (!overview.monitoring24h.ready) return "数据积累中";
		return kind === "percent" ? formatPercent(value) : formatLatency(value);
	}

	function monitoringWindowTitle(): string {
		if (!overview) return "等待定时监控";
		if (overview.monitoring24h.stale) return "定时监控已中断";
		if (overview.monitoring24h.ready) return "24 小时监控覆盖正常";
		return "24 小时数据积累中";
	}

	function monitoringWindowDetail(): string {
		if (!overview) return "正在等待首个定时样本。";
		const monitor = overview.monitoring24h;
		const coverage = `${monitor.sampleCount}/${monitor.expectedSamples} 个样本 · 覆盖 ${monitor.coveragePercent.toFixed(2)}%`;
		if (!monitor.lastMonitorAt) return `${coverage} · 尚未收到定时样本`;
		return `${coverage} · 最近样本 ${formatDate(monitor.lastMonitorAt)}`;
	}

	function isFiniteMetric(value: number | null | undefined): value is number {
		return value !== null && value !== undefined && Number.isFinite(value);
	}

	function missingMetricDetail(): string {
		if (!overview) {
			return "等待采样";
		}
		return overview.source.metricsAvailable === false
			? "Supabase Metrics API 暂不可用，当前无样本"
			: "Supabase Metrics API 未返回可用样本";
	}

	function resourceUsageDetail(
		used: number | null | undefined,
		total: number | null | undefined,
		prefix = "",
	): string {
		if (!isFiniteMetric(used) || !isFiniteMetric(total)) {
			return missingMetricDetail();
		}
		const usage = `${formatBytes(used)} / ${formatBytes(total)}`;
		return prefix ? `${prefix} · ${usage}` : usage;
	}

	function connectionUsageDetail(
		connections: number | null | undefined,
		maxConnections: number | null | undefined,
	): string {
		if (!isFiniteMetric(connections) || !isFiniteMetric(maxConnections)) {
			return missingMetricDetail();
		}
		return `${formatNumber(connections)} / ${formatNumber(maxConnections)} 个连接`;
	}

	function cpuMetricDetail(): string {
		if (!overview) {
			return "等待采样";
		}
		if (overview.infrastructure.cpu.note) {
			return overview.infrastructure.cpu.note;
		}
		return isFiniteMetric(overview.infrastructure.cpu.usedPercent)
			? "相邻采样计数器差值"
			: missingMetricDetail();
	}

	function formatDate(value: string | null | undefined): string {
		if (!value) return "暂无";
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "暂无";
		return new Intl.DateTimeFormat("zh-CN", {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	}

	function statusLabel(status: string): string {
		if (status === "up" || status === "healthy") {
			return "运行正常";
		}
		if (status === "degraded") {
			return "性能降级";
		}
		if (status === "down") {
			return "服务异常";
		}
		return "状态未知";
	}

	function filterCount(filter: AdminCommentFilter): number {
		return filter === "all" ? commentCounts.all : commentCounts[filter];
	}

	function auditActionLabel(action: string): string {
		const labels: Record<string, string> = {
			approve: "通过评论",
			reject: "拒绝评论",
			spam: "标记垃圾评论",
			delete: "删除评论",
			comment_approve: "通过评论",
			comment_reject: "拒绝评论",
			comment_spam: "标记垃圾评论",
			comment_delete: "删除评论",
			"comment.approve": "通过评论",
			"comment.reject": "拒绝评论",
			"comment.spam": "标记垃圾评论",
			"comment.delete": "删除评论",
		};
		return labels[action] ?? action;
	}

	function auditStatusLabel(status: string | null | undefined): string {
		if (!status) return "—";
		const labels: Record<string, string> = {
			pending: "待审核",
			approved: "已通过",
			rejected: "已拒绝",
			spam: "垃圾评论",
			deleted: "已删除",
		};
		return labels[status] ?? status;
	}

	async function currentToken(): Promise<string> {
		const supabase = getSupabaseBrowserClient();
		if (!supabase) throw new Error("Supabase 登录服务未配置。");
		const { data, error } = await supabase.auth.getSession();
		if (error || !data.session?.access_token) {
			throw new AdminApiError("管理员登录已失效。", 401, "AUTH_REQUIRED");
		}
		session = data.session;
		return data.session.access_token;
	}

	async function loadOverview(token?: string) {
		if (loadingOverview) return;
		loadingOverview = true;
		const started = performance.now();
		try {
			const accessToken = token ?? (await currentToken());
			overview = await getAdminOverview(accessToken);
			browserRttMs = Math.round(performance.now() - started);
		} finally {
			loadingOverview = false;
		}
	}

	async function loadComments(token?: string) {
		if (loadingComments) return;
		loadingComments = true;
		try {
			const accessToken = token ?? (await currentToken());
			const result = await getAdminComments(accessToken, commentFilter, {
				limit: 60,
				offset: 0,
			});
			comments = result.items;
			commentCounts = result.counts;
		} finally {
			loadingComments = false;
		}
	}

	async function loadAudit(token?: string) {
		if (loadingAudit) return;
		loadingAudit = true;
		try {
			const accessToken = token ?? (await currentToken());
			const result = await getAdminAuditLog(accessToken, {
				limit: 16,
				offset: 0,
			});
			auditEntries = result.items;
		} finally {
			loadingAudit = false;
		}
	}

	async function loadAll(token?: string, announce = false) {
		try {
			const accessToken = token ?? (await currentToken());
			const results = await Promise.allSettled([
				loadOverview(accessToken),
				loadComments(accessToken),
				loadAudit(accessToken),
			]);
			const rejected = results.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (rejected) throw rejected.reason;
			if (announce) showFeedback("运维数据已刷新。", "success");
		} catch (error) {
			if (error instanceof AdminApiError && error.status === 401) {
				authState = "signed-out";
				authMessage = "登录已过期，请重新授权。";
			}
			showFeedback(readableError(error), "error", 5200);
		}
	}

	async function verifySession(nextSession: Session | null) {
		const version = ++authVersion;
		activeController?.abort();
		activeController = null;
		session = nextSession;
		me = null;

		if (!nextSession?.access_token) {
			authState = "signed-out";
			authMessage = "使用站长 GitHub 账号授权后进入。";
			return;
		}

		authState = "checking";
		authMessage = "正在向后端核验 GitHub 管理员身份…";
		const controller = new AbortController();
		activeController = controller;

		try {
			const identity = await getAdminMe(
				nextSession.access_token,
				controller.signal,
			);
			if (disposed || version !== authVersion) return;
			if (!identity.isAdmin)
				throw new AdminApiError("此账号没有管理员权限。", 403);
			me = identity;
			authState = "ready";
			authMessage = "";
			await loadAll(nextSession.access_token);
			startAutoRefresh();
		} catch (error) {
			if (
				disposed ||
				controller.signal.aborted ||
				version !== authVersion
			) {
				return;
			}
			if (error instanceof AdminApiError && error.status === 403) {
				authState = "denied";
				authMessage = "当前 GitHub 账号不是本站管理员。";
			} else if (error instanceof AdminApiError && error.status === 401) {
				authState = "signed-out";
				authMessage = "登录已过期，请重新授权。";
			} else {
				authState = "error";
				authMessage = readableError(error);
			}
		} finally {
			if (activeController === controller) activeController = null;
		}
	}

	async function refreshReadySession(nextSession: Session) {
		if (
			authState !== "ready" ||
			!session ||
			session.user.id !== nextSession.user.id
		) {
			await verifySession(nextSession);
			return;
		}

		const version = ++authVersion;
		activeController?.abort();
		const controller = new AbortController();
		activeController = controller;
		session = nextSession;

		try {
			const identity = await getAdminMe(
				nextSession.access_token,
				controller.signal,
			);
			if (disposed || version !== authVersion) return;
			if (!identity.isAdmin) {
				throw new AdminApiError("此账号没有管理员权限。", 403);
			}
			me = identity;
			await loadAll(nextSession.access_token);
		} catch (error) {
			if (
				disposed ||
				controller.signal.aborted ||
				version !== authVersion
			) {
				return;
			}
			if (error instanceof AdminApiError && error.status === 403) {
				authState = "denied";
				authMessage = "当前 GitHub 账号不是本站管理员。";
			} else if (error instanceof AdminApiError && error.status === 401) {
				authState = "signed-out";
				authMessage = "登录已过期，请重新授权。";
			} else {
				showFeedback(
					`管理员身份后台复核暂时失败：${readableError(error)}`,
					"error",
					5200,
				);
			}
		} finally {
			if (activeController === controller) activeController = null;
		}
	}

	function startAutoRefresh() {
		if (refreshTimer) window.clearInterval(refreshTimer);
		refreshTimer = window.setInterval(
			() => {
				if (authState === "ready" && !document.hidden) void loadAll();
			},
			Math.max(60, overview?.source.refreshSeconds ?? 60) * 1000,
		);
	}

	async function signInWithGitHub() {
		if (signingIn) return;
		const supabase = getSupabaseBrowserClient();
		if (!supabase) {
			authState = "error";
			authMessage = "Supabase 登录服务未配置。";
			return;
		}

		signingIn = true;
		try {
			const base = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
			const redirectPath = `${base}admin/`.replace(/\/{2,}/g, "/");
			const redirectTo = new URL(
				redirectPath,
				window.location.origin,
			).toString();
			const { error } = await supabase.auth.signInWithOAuth({
				provider: "github",
				options: {
					redirectTo,
					scopes: "read:user",
				},
			});
			if (error) throw error;
		} catch (error) {
			showFeedback(
				`GitHub 授权失败：${readableError(error)}`,
				"error",
				5200,
			);
			signingIn = false;
		}
	}

	async function signOut() {
		const supabase = getSupabaseBrowserClient();
		if (supabase) await supabase.auth.signOut();
		if (refreshTimer) window.clearInterval(refreshTimer);
		overview = null;
		comments = [];
		auditEntries = [];
		commentCounts = { ...EMPTY_COUNTS };
		me = null;
		authState = "signed-out";
		authMessage = "已安全退出管理员后台。";
	}

	async function changeCommentFilter(filter: AdminCommentFilter) {
		if (commentFilter === filter || loadingComments) return;
		commentFilter = filter;
		try {
			await loadComments();
		} catch (error) {
			showFeedback(readableError(error), "error");
		}
	}

	async function moderateComment(
		comment: AdminComment,
		decision: AdminModerationDecision,
	) {
		if (moderatingId) return;
		if (
			decision === "delete" &&
			!window.confirm("确认永久删除这条评论吗？该操作会写入审计记录。")
		) {
			return;
		}

		moderatingId = comment.id;
		try {
			const token = await currentToken();
			await moderateAdminComment(token, {
				commentId: comment.id,
				decision,
			});
			const actionText: Record<AdminModerationDecision, string> = {
				approve: "评论已通过审核。",
				reject: "评论已拒绝。",
				spam: "评论已标记为垃圾内容。",
				delete: "评论已删除。",
			};
			showFeedback(actionText[decision], "success");
			await Promise.all([
				loadComments(token),
				loadOverview(token),
				loadAudit(token),
			]);
		} catch (error) {
			showFeedback(readableError(error), "error", 5200);
		} finally {
			moderatingId = "";
		}
	}

	onMount(() => {
		disposed = false;
		if (!isSupabaseBrowserConfigured || !isAdminApiConfigured) {
			authState = "error";
			authMessage = "管理员身份服务尚未配置。";
			return;
		}

		const supabase = getSupabaseBrowserClient();
		if (!supabase) {
			authState = "error";
			authMessage = "无法初始化管理员身份服务。";
			return;
		}

		const { data } = supabase.auth.onAuthStateChange(
			(event, nextSession) => {
				const canKeepReadyShell =
					event !== "SIGNED_OUT" &&
					authState === "ready" &&
					Boolean(nextSession?.access_token) &&
					session?.user.id === nextSession?.user.id;
				window.setTimeout(
					() =>
						void (canKeepReadyShell && nextSession
							? refreshReadySession(nextSession)
							: verifySession(nextSession)),
					0,
				);
			},
		);
		authSubscription = data.subscription;

		void supabase.auth
			.getSession()
			.then(({ data: sessionData, error }) => {
				if (error) throw error;
				return verifySession(sessionData.session);
			})
			.catch((error) => {
				authState = "error";
				authMessage = readableError(error);
			});
	});

	onDestroy(() => {
		disposed = true;
		authVersion += 1;
		activeController?.abort();
		authSubscription?.unsubscribe();
		if (refreshTimer) window.clearInterval(refreshTimer);
		if (feedbackTimer) window.clearTimeout(feedbackTimer);
	});
</script>

<section
	class="admin-shell card-base onload-animation"
	class:content-active={authState === "ready" && activeTab === "content"}
	aria-labelledby="admin-console-title"
>
	{#if authState !== "ready"}
		<div class="auth-gate">
			<!--
				红框动画结构：
				1. auth-orbit：动画整体画布；
				2. ring-one：外层实线轨道；
				3. ring-two：内层虚线反向轨道；
				4. auth-core：中间的盾牌方块。
				具体尺寸、速度和偏移量请搜索下方 CSS 中的“红框动画手动校准区”。
			-->
			<div class="auth-orbit" aria-hidden="true">
				<!-- 外层轨道及其蓝色粒子 -->
				<div class="orbit-ring ring-one"></div>
				<!-- 内层虚线轨道及其蓝色粒子 -->
				<div class="orbit-ring ring-two"></div>
				<!-- 中央盾牌方块 -->
				<div class="auth-core">
					<Icon icon="material-symbols:shield-person-rounded" />
				</div>
			</div>
			<p class="eyebrow">仅限站长</p>
			<h1 id="admin-console-title">管理员后台</h1>

			{#if authState === "loading" || authState === "checking"}
				<div class="auth-status" role="status">
					<span class="spinner"></span>
					{authMessage}
				</div>
			{:else if authState === "signed-out"}
				<button
					class="github-login"
					type="button"
					on:click={signInWithGitHub}
					disabled={signingIn}
				>
					<Icon icon="fa7-brands:github" />
					<span
						>{signingIn
							? "正在跳转…"
							: "使用 GitHub 管理员账号登录"}</span
					>
				</button>
			{:else if authState === "denied"}
				<div class="auth-alert denied" role="alert">
					<Icon icon="material-symbols:lock" />
					<div>
						<strong>没有访问权限</strong><span>{authMessage}</span>
					</div>
				</div>
				<button
					class="secondary-button"
					type="button"
					on:click={signOut}>退出当前账号</button
				>
			{:else}
				<div class="auth-alert" role="alert">
					<Icon icon="material-symbols:cloud-off-rounded" />
					<div>
						<strong>后台连接失败</strong><span>{authMessage}</span>
					</div>
				</div>
				<div class="auth-actions">
					<button
						class="secondary-button"
						type="button"
						on:click={() => location.reload()}>重新连接</button
					>
					{#if session}<button
							class="secondary-button"
							type="button"
							on:click={signOut}>退出账号</button
						>{/if}
				</div>
			{/if}
		</div>
	{:else}
		<header class="console-header">
			<div class="identity-block">
				{#if me?.user.avatarUrl}
					<img
						src={me.user.avatarUrl}
						alt=""
						referrerpolicy="no-referrer"
					/>
				{:else}
					<div class="identity-icon">
						<Icon
							icon="material-symbols:admin-panel-settings-rounded"
						/>
					</div>
				{/if}
				<div>
					<p class="eyebrow">站点运维中心</p>
					<h1 id="admin-console-title">管理员后台</h1>
					<p>欢迎回来，{me?.user.login || "站长"}。</p>
				</div>
			</div>
			<div class="console-actions">
				<span class="sample-time">
					<Icon icon="material-symbols:schedule-rounded" />
					{overview
						? `采样于 ${formatDate(overview.sampledAt)}`
						: "等待首个样本"}
				</span>
				<button
					class="icon-action"
					type="button"
					on:click={() => loadAll(undefined, true)}
					disabled={loadingOverview}
					aria-label="刷新后台数据"
				>
					<Icon
						icon="material-symbols:refresh-rounded"
						class={loadingOverview ? "spinning" : ""}
					/>
				</button>
				<button
					class="icon-action"
					type="button"
					on:click={signOut}
					aria-label="退出管理员后台"
				>
					<Icon icon="material-symbols:logout-rounded" />
				</button>
			</div>
		</header>

		<nav class="console-tabs" aria-label="管理员后台栏目">
			<button
				type="button"
				class:active={activeTab === "operations"}
				on:click={() => (activeTab = "operations")}
			>
				<Icon icon="material-symbols:fact-check-rounded" />
				<span>基础运维</span>
				{#if commentCounts.pending > 0}<strong
						>{commentCounts.pending}</strong
					>{/if}
			</button>
			<button
				type="button"
				class:active={activeTab === "dashboard"}
				on:click={() => (activeTab = "dashboard")}
			>
				<Icon icon="material-symbols:monitoring-rounded" />
				<span>运行仪表盘</span>
			</button>
			<button
				type="button"
				class:active={activeTab === "content"}
				on:click={() => (activeTab = "content")}
			>
				<Icon icon="material-symbols:edit-document-rounded" />
				<span>内容管理</span>
			</button>
		</nav>

		{#if feedback}
			<div
				class="toast"
				class:success={feedbackKind === "success"}
				class:error={feedbackKind === "error"}
				role="status"
			>
				<Icon
					icon={feedbackKind === "success"
						? "material-symbols:check-circle-rounded"
						: feedbackKind === "error"
							? "material-symbols:error-rounded"
							: "material-symbols:info-rounded"}
				/>
				{feedback}
			</div>
		{/if}

		{#if activeTab === "operations"}
			<div class="tab-panel operations-panel">
				<section class="kpi-grid" aria-label="网站基础数据">
					<article class="kpi-card">
						<Icon icon="material-symbols:article-rounded" />
						<div>
							<strong
								>{formatNumber(
									overview?.content.published,
								)}</strong
							><span>已发布内容</span>
						</div>
					</article>
					<article class="kpi-card">
						<Icon icon="material-symbols:visibility-rounded" />
						<div>
							<strong
								>{formatNumber(overview?.content.views)}</strong
							><span>总浏览量</span>
						</div>
					</article>
					<article class="kpi-card">
						<Icon icon="material-symbols:favorite-rounded" />
						<div>
							<strong
								>{formatNumber(overview?.content.likes)}</strong
							><span>总点赞</span>
						</div>
					</article>
					<article class="kpi-card">
						<Icon icon="material-symbols:ios-share-rounded" />
						<div>
							<strong
								>{formatNumber(
									overview?.content.shares,
								)}</strong
							><span>总分享</span>
						</div>
					</article>
					<article class="kpi-card attention">
						<Icon icon="material-symbols:pending-actions-rounded" />
						<div>
							<strong
								>{formatNumber(commentCounts.pending)}</strong
							><span>待审核评论</span>
						</div>
					</article>
					<article class="kpi-card">
						<Icon icon="material-symbols:forum-rounded" />
						<div>
							<strong>{formatNumber(commentCounts.all)}</strong
							><span>全部评论</span>
						</div>
					</article>
				</section>

				<section
					class="section-card moderation-section"
					aria-labelledby="moderation-title"
				>
					<div class="section-heading">
						<div>
							<p class="eyebrow">评论审核队列</p>
							<h2 id="moderation-title">评论审核</h2>
							<span>审核通过后，评论才会出现在公开文章中。</span>
						</div>
						<button
							class="secondary-button compact"
							type="button"
							on:click={() => loadComments()}
							disabled={loadingComments}
							><Icon
								icon="material-symbols:refresh-rounded"
								class={loadingComments ? "spinning" : ""}
							/>刷新队列</button
						>
					</div>

					<div
						class="filter-row"
						role="tablist"
						aria-label="评论状态筛选"
					>
						{#each FILTERS as filter}
							<button
								type="button"
								role="tab"
								aria-selected={commentFilter === filter.value}
								class:active={commentFilter === filter.value}
								on:click={() =>
									changeCommentFilter(filter.value)}
							>
								<Icon icon={filter.icon} /><span
									>{filter.label}</span
								><strong>{filterCount(filter.value)}</strong>
							</button>
						{/each}
					</div>

					{#if loadingComments && comments.length === 0}
						<div class="loading-block">
							<span class="spinner"></span>正在读取审核队列…
						</div>
					{:else if comments.length === 0}
						<div class="empty-state">
							<Icon icon="material-symbols:inbox-rounded" />
							<h3>这里很干净</h3>
							<p>当前筛选条件下没有评论。</p>
						</div>
					{:else}
						<div class="comment-list">
							{#each comments as comment (comment.id)}
								<article
									class="comment-card"
									class:pending={comment.status === "pending"}
								>
									<header>
										<div class="comment-avatar">
											{comment.authorName
												.slice(0, 1)
												.toUpperCase()}
										</div>
										<div class="comment-meta">
											<strong>{comment.authorName}</strong
											><span
												>{formatDate(comment.createdAt)} ·
												<a
													href={comment.post
														.canonicalPath}
													target="_blank"
													rel="noopener"
													>{comment.post.title}</a
												></span
											>
										</div>
										<span
											class={`status-badge ${comment.status}`}
											>{FILTERS.find(
												(item) =>
													item.value ===
													comment.status,
											)?.label ?? comment.status}</span
										>
									</header>
									<p class="comment-body">{comment.body}</p>
									{#if comment.moderationNote}<p
											class="moderation-note"
										>
											<Icon
												icon="material-symbols:sticky-note-2-rounded"
											/>{comment.moderationNote}
										</p>{/if}
									<div class="comment-actions">
										<button
											class="approve"
											type="button"
											on:click={() =>
												moderateComment(
													comment,
													"approve",
												)}
											disabled={Boolean(moderatingId)}
											><Icon
												icon="material-symbols:check-rounded"
											/>通过</button
										>
										<button
											class="reject"
											type="button"
											on:click={() =>
												moderateComment(
													comment,
													"reject",
												)}
											disabled={Boolean(moderatingId)}
											><Icon
												icon="material-symbols:close-rounded"
											/>拒绝</button
										>
										<button
											type="button"
											on:click={() =>
												moderateComment(
													comment,
													"spam",
												)}
											disabled={Boolean(moderatingId)}
											><Icon
												icon="material-symbols:report-rounded"
											/>垃圾</button
										>
										<button
											class="delete"
											type="button"
											on:click={() =>
												moderateComment(
													comment,
													"delete",
												)}
											disabled={Boolean(moderatingId)}
											><Icon
												icon="material-symbols:delete-outline-rounded"
											/>删除</button
										>
										{#if moderatingId === comment.id}<span
												class="inline-progress"
												><span class="spinner"
												></span>处理中</span
											>{/if}
									</div>
								</article>
							{/each}
						</div>
					{/if}
				</section>

				<section class="section-card" aria-labelledby="audit-title">
					<div class="section-heading">
						<div>
							<p class="eyebrow">审计记录</p>
							<h2 id="audit-title">最近管理操作</h2>
							<span>每一次审核动作都会留下服务端审计记录。</span>
						</div>
					</div>
					{#if loadingAudit && auditEntries.length === 0}
						<div class="loading-block">
							<span class="spinner"></span>正在加载审计记录…
						</div>
					{:else if auditEntries.length === 0}
						<div class="empty-inline">暂无管理操作记录。</div>
					{:else}
						<div class="audit-list">
							{#each auditEntries as entry}
								<div class="audit-item">
									<span class="audit-dot"></span>
									<div>
										<strong
											>{auditActionLabel(
												entry.action,
											)}</strong
										>
										<p>
											{auditStatusLabel(entry.oldStatus)} →
											{auditStatusLabel(
												entry.newStatus ||
													(entry.action.includes(
														"delete",
													)
														? "deleted"
														: null),
											)}
										</p>
									</div>
									<time datetime={entry.createdAt}
										>{formatDate(entry.createdAt)}</time
									>
								</div>
							{/each}
						</div>
					{/if}
				</section>
			</div>
		{:else if activeTab === "dashboard"}
			<div class="tab-panel dashboard-panel">
				<section
					class="status-banner"
					class:healthy={overview?.status === "healthy"}
				>
					<div class="status-orb">
						<span></span><Icon
							icon={overview?.status === "healthy"
								? "material-symbols:cloud-done-rounded"
								: "material-symbols:warning-rounded"}
						/>
					</div>
					<div>
						<p class="eyebrow">实时状态</p>
						<h2>
							{overview?.status === "healthy"
								? "所有核心服务运行正常"
								: overview
									? "部分服务需要关注"
									: "正在采集运行状态"}
						</h2>
						<span
							>{overview?.source.metricsAvailable === false
								? "Supabase 指标接口暂不可用；数据库业务指标仍来自实时查询，资源指标显示暂无。"
								: "数据来自 Supabase Metrics API、数据库实时查询和 HTTP 探测，不使用模拟数值。"}</span
						>
					</div>
					<div class="rtt-block">
						<span>管理接口端到端响应时间</span><strong
							>{formatLatency(browserRttMs)}</strong
						>
					</div>
				</section>

				<section class="service-grid" aria-label="核心服务状态">
					{#each serviceRows as service}
						<article
							class="service-card"
							class:degraded={service.probe.status === "degraded"}
							class:down={service.probe.status === "down"}
						>
							<div class="service-icon">
								<Icon icon={service.icon} />
							</div>
							<div class="service-copy">
								<div>
									<h3>{service.name}</h3>
									<span
										class:online={service.probe.status ===
											"up" ||
											service.probe.status === "healthy"}
										class:degraded={service.probe.status ===
											"degraded"}
										>{statusLabel(
											service.probe.status,
										)}</span
									>
								</div>
								<p>{service.description}</p>
								<dl>
									<div>
										<dt>实时延迟</dt>
										<dd>
											{formatLatency(
												service.probe.latencyMs,
											)}
										</dd>
									</div>
									<div>
										<dt>24 小时可用率</dt>
										<dd>
											{monitoringMetric(
												service.uptime,
												"percent",
											)}
										</dd>
									</div>
									<div>
										<dt>24 小时 95 分位</dt>
										<dd>
											{monitoringMetric(
												service.p95,
												"latency",
											)}
										</dd>
									</div>
								</dl>
							</div>
						</article>
					{/each}
				</section>

				<section
					class="monitoring-window"
					class:stale={overview?.monitoring24h.stale}
					class:collecting={overview && !overview.monitoring24h.ready}
					aria-live="polite"
				>
					<div class="monitoring-window-icon">
						<Icon
							icon={overview?.monitoring24h.stale
								? "material-symbols:timer-off-rounded"
								: overview?.monitoring24h.ready
									? "material-symbols:verified-rounded"
									: "material-symbols:hourglass-top-rounded"}
						/>
					</div>
					<div class="monitoring-window-copy">
						<strong>{monitoringWindowTitle()}</strong>
						<span>{monitoringWindowDetail()}</span>
					</div>
					<div
						class="monitoring-progress"
						role="progressbar"
						aria-label="24 小时定时监控覆盖率"
						aria-valuemin="0"
						aria-valuemax="100"
						aria-valuenow={overview?.monitoring24h
							.coveragePercent ?? 0}
					>
						<span
							style={`width: ${Math.min(100, Math.max(0, overview?.monitoring24h.coveragePercent ?? 0))}%`}
						></span>
					</div>
				</section>

				<section class="gauge-grid" aria-label="Supabase 资源占用">
					<DonutGauge
						label="处理器使用率"
						value={overview?.infrastructure.cpu.usedPercent ?? null}
						detail={cpuMetricDetail()}
						icon="material-symbols:speed-rounded"
						warningAt={70}
						criticalAt={90}
					/>
					<DonutGauge
						label="内存使用率"
						value={overview?.infrastructure.memory.usedPercent ??
							null}
						detail={resourceUsageDetail(
							overview?.infrastructure.memory.usedBytes,
							overview?.infrastructure.memory.totalBytes,
						)}
						icon="material-symbols:memory-rounded"
						warningAt={75}
						criticalAt={90}
					/>
					<DonutGauge
						label="数据盘使用率"
						value={overview?.infrastructure.disk.usedPercent ??
							null}
						detail={resourceUsageDetail(
							overview?.infrastructure.disk.usedBytes,
							overview?.infrastructure.disk.totalBytes,
							overview?.infrastructure.disk.mountpoint,
						)}
						icon="material-symbols:hard-drive"
						warningAt={70}
						criticalAt={85}
					/>
					<DonutGauge
						label="数据库连接"
						value={overview?.infrastructure.database
							.connectionPercent ?? null}
						detail={connectionUsageDetail(
							overview?.infrastructure.database.connections,
							overview?.infrastructure.database.maxConnections,
						)}
						icon="material-symbols:database"
						warningAt={60}
						criticalAt={85}
					/>
				</section>

				<section class="detail-grid">
					<article class="section-card metric-details">
						<div class="section-heading">
							<div>
								<p class="eyebrow">数据库状态</p>
								<h2>数据库健康</h2>
								<span
									>连接、缓存和容量均来自服务端白名单指标。</span
								>
							</div>
						</div>
						<div class="detail-list">
							<div>
								<span
									><Icon
										icon="material-symbols:database"
									/>数据库大小</span
								><strong
									>{formatBytes(
										overview?.infrastructure.database
											.sizeBytes,
									)}</strong
								>
							</div>
							<div>
								<span
									><Icon
										icon="material-symbols:cached-rounded"
									/>缓存命中率</span
								><strong
									>{formatPercent(
										overview?.infrastructure.database
											.cacheHitPercent,
									)}</strong
								>
							</div>
							<div>
								<span
									><Icon
										icon="material-symbols:description-rounded"
									/>预写日志大小</span
								><strong
									>{formatBytes(
										overview?.infrastructure.database
											.walBytes,
									)}</strong
								>
							</div>
							<div>
								<span
									><Icon
										icon="material-symbols:photo-library-rounded"
									/>媒体对象</span
								><strong
									>{formatNumber(
										overview?.infrastructure.storage
											.objects,
									)} · {formatBytes(
										overview?.infrastructure.storage
											.sizeBytes,
									)}</strong
								>
							</div>
							<div>
								<span
									><Icon
										icon="material-symbols:query-stats-rounded"
									/>数据库查询耗时</span
								><strong
									>{formatLatency(
										overview?.latency.databaseMs,
									)}</strong
								>
							</div>
							<div>
								<span
									><Icon
										icon="material-symbols:deployed-code"
									/>边缘函数处理耗时</span
								><strong
									>{formatLatency(
										overview?.latency.edgeMs,
									)}</strong
								>
							</div>
						</div>
					</article>

					<article class="section-card metric-details">
						<div class="section-heading">
							<div>
								<p class="eyebrow">系统负载</p>
								<h2>负载与连接</h2>
								<span
									>Linux
									平均负载为真实采样值，不伪装成百分比。</span
								>
							</div>
						</div>
						<div class="load-row">
							<div>
								<strong
									>{overview?.infrastructure.load.one?.toFixed(
										2,
									) ?? "暂无"}</strong
								><span>1 分钟</span>
							</div>
							<div>
								<strong
									>{overview?.infrastructure.load.five?.toFixed(
										2,
									) ?? "暂无"}</strong
								><span>5 分钟</span>
							</div>
							<div>
								<strong
									>{overview?.infrastructure.load.fifteen?.toFixed(
										2,
									) ?? "暂无"}</strong
								><span>15 分钟</span>
							</div>
						</div>
						<div class="latency-stack">
							<div>
								<span>网站往返响应时间</span><strong
									>{formatLatency(
										overview?.latency.siteMs,
									)}</strong
								>
							</div>
							<div>
								<span>互动接口往返响应时间</span><strong
									>{formatLatency(
										overview?.latency.blogApiMs,
									)}</strong
								>
							</div>
							<div>
								<span>数据库连接压力</span><strong
									>{formatPercent(
										overview?.infrastructure.database
											.connectionPercent,
									)}</strong
								>
							</div>
						</div>
					</article>
				</section>

				<section class="chart-grid">
					<LatencyChart
						points={siteHistory}
						label="GitHub Pages · 24 小时往返响应时间"
						color="var(--primary)"
						intervalMinutes={overview?.monitoring24h
							.intervalMinutes ?? 10}
						sampleCount={overview?.monitoring24h.sampleCount ?? 0}
						expectedSamples={overview?.monitoring24h
							.expectedSamples ?? 144}
						coveragePercent={overview?.monitoring24h
							.coveragePercent ?? 0}
						lastMonitorAt={overview?.monitoring24h.lastMonitorAt ??
							null}
						stale={overview?.monitoring24h.stale ?? false}
						ready={overview?.monitoring24h.ready ?? false}
					/>
					<LatencyChart
						points={apiHistory}
						label="博客互动接口 · 24 小时往返响应时间"
						color="#8b78e6"
						intervalMinutes={overview?.monitoring24h
							.intervalMinutes ?? 10}
						sampleCount={overview?.monitoring24h.sampleCount ?? 0}
						expectedSamples={overview?.monitoring24h
							.expectedSamples ?? 144}
						coveragePercent={overview?.monitoring24h
							.coveragePercent ?? 0}
						lastMonitorAt={overview?.monitoring24h.lastMonitorAt ??
							null}
						stale={overview?.monitoring24h.stale ?? false}
						ready={overview?.monitoring24h.ready ?? false}
					/>
				</section>

				<section class="composition-grid">
					<article class="section-card composition-card">
						<div class="pie-ring" style={contentPieStyle}>
							<div>
								<strong
									>{formatNumber(
										(overview?.content.articles ?? 0) +
											(overview?.content.diaries ?? 0),
									)}</strong
								><span>内容</span>
							</div>
						</div>
						<div class="composition-copy">
							<p class="eyebrow">内容构成</p>
							<h2>内容构成</h2>
							<ul>
								<li>
									<span class="legend primary"
									></span>文章<strong
										>{formatNumber(
											overview?.content.articles,
										)}</strong
									>
								</li>
								<li>
									<span class="legend purple"
									></span>日记<strong
										>{formatNumber(
											overview?.content.diaries,
										)}</strong
									>
								</li>
							</ul>
						</div>
					</article>
					<article class="section-card composition-card">
						<div class="pie-ring" style={commentPieStyle}>
							<div>
								<strong>{formatNumber(commentTotal)}</strong
								><span>评论</span>
							</div>
						</div>
						<div class="composition-copy">
							<p class="eyebrow">审核构成</p>
							<h2>评论状态</h2>
							<ul>
								<li>
									<span class="legend green"
									></span>已通过<strong
										>{formatNumber(
											commentCounts.approved,
										)}</strong
									>
								</li>
								<li>
									<span class="legend yellow"
									></span>待审核<strong
										>{formatNumber(
											commentCounts.pending,
										)}</strong
									>
								</li>
								<li>
									<span class="legend red"
									></span>已拒绝<strong
										>{formatNumber(
											commentCounts.rejected,
										)}</strong
									>
								</li>
								<li>
									<span class="legend gray"></span>垃圾<strong
										>{formatNumber(
											commentCounts.spam,
										)}</strong
									>
								</li>
							</ul>
						</div>
					</article>
				</section>

				<p class="data-source-note">
					<Icon icon="material-symbols:verified-rounded" />{overview
						?.source.metricsAvailable === false
						? "Supabase 指标接口暂不可用，资源指标显示暂无。"
						: "资源数据来自 Supabase Metrics API。"}HTTP“延迟”是往返响应时间，不是
					网络层 Ping；24
					小时统计仅在定时样本覆盖达标且仍新鲜时展示，缺失指标不会使用模拟数值。
				</p>
			</div>
		{/if}

		<div class="tab-panel content-panel" hidden={activeTab !== "content"}>
			<AdminContentStudio
				embedded={true}
				accessToken={session?.access_token ?? ""}
			/>
		</div>
	{/if}
</section>

<style>
	.admin-shell {
		position: relative;
		z-index: 10;
		width: 100%;
		min-height: 36rem;
		overflow: hidden;
		padding: 1.25rem;
	}
	.admin-shell.content-active {
		overflow: visible;
	}
	.eyebrow {
		margin: 0 0 0.2rem;
		color: var(--primary);
		font-size: 0.65rem;
		font-weight: 800;
		letter-spacing: 0.16em;
	}
	/* 登录区域整体定位：这里会影响红框动画在整张卡片中的上下位置。 */
	.auth-gate {
		display: flex;
		/* 登录区域的最低高度；数值越大，整体可用的垂直居中空间越大。 */
		min-height: 34rem;
		flex-direction: column;
		align-items: center;
		/* 当前为垂直居中；可改为 flex-start / flex-end 调整整体对齐方向。 */
		justify-content: center;
		/* 第一个数值控制上下留白，第二个数值控制左右留白。 */
		padding: 2rem 1rem;
		text-align: center;
	}
	.auth-gate h1 {
		/* 上方与“仅限站长”的距离为 0.3rem，下方与登录按钮的距离为 1.5rem。 */
		margin: 0.3rem 0 1.5rem;
		font-size: clamp(2rem, 6vw, 3.2rem);
		color: rgb(0 0 0 / 86%);
	}

	/* ===== 红框动画手动校准区：开始 ===== */
	/* 动画整体画布：优先在这里调整整组动画的尺寸和下方间距。 */
	.auth-orbit {
		/* 作为两条绝对定位轨道和中央方块的定位基准。 */
		position: relative;
		display: grid;
		/* 整组动画宽度；需要等比缩放时应与下面的 height 一起修改。 */
		width: 9rem;
		/* 整组动画高度；通常与 width 保持相同以维持正圆轨道。 */
		height: 9rem;
		/* 将中央盾牌方块放在动画画布的几何中心。 */
		place-items: center;
		/* 动画底部到“仅限站长”文字之间的距离。 */
		margin-bottom: 1.2rem;
	}
	/* 两条轨道共用的基础样式。 */
	.orbit-ring {
		/* 相对于 auth-orbit 进行绝对定位。 */
		position: absolute;
		/* 0 表示轨道贴满 9rem 画布；增大数值会让轨道整体向内缩。 */
		inset: 0;
		/* 轨道线宽、颜色强度和透明度。35% 越大，轨道颜色越明显。 */
		border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent);
		/* 50% 让正方形轨道变成圆形。 */
		border-radius: 50%;
		/* 外轨道旋转速度：10s 越小转得越快；linear 保持匀速。 */
		animation: spin 10s linear infinite;
	}
	/* 每条轨道上的蓝色粒子；粒子会随所属轨道一起旋转。 */
	.orbit-ring::after {
		position: absolute;
		/*
			粒子距离轨道顶边的垂直偏移；减小会更靠外，增大会更靠内。
			手动校准后，-0.3rem 可让两个粒子正好与各自轨道对齐。
		*/
		top: -0.3rem;
		/*
			粒子的水平起点。50% 以粒子左边缘对准轨道中心线；
			如需让粒子几何中心严格对齐正上方，可手动微调此百分比。
		*/
		left: 50%;
		/* 粒子直径：宽高应保持一致。 */
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		/* 粒子本体颜色。 */
		background: var(--primary);
		/* 粒子外发光范围；1rem 越大，光晕越宽。 */
		box-shadow: 0 0 1rem var(--primary);
		content: "";
	}
	/* 内层虚线轨道的独立参数。 */
	.ring-two {
		/* 内轨道相对外轨道向内收缩的距离。 */
		inset: 1rem;
		/* 将内轨道改为虚线；删除此行即可恢复实线。 */
		border-style: dashed;
		/* 让内轨道与外轨道反向旋转。 */
		animation-direction: reverse;
		/* 内轨道旋转速度：7s 越小转得越快。 */
		animation-duration: 7s;
	}
	/* 中央盾牌方块。 */
	.auth-core {
		display: grid;
		/* 中央方块宽度。 */
		width: 5.2rem;
		/* 中央方块高度；通常与 width 一起修改。 */
		height: 5.2rem;
		place-items: center;
		/* 方块圆角；数值越大越接近圆形。 */
		border-radius: 1.6rem;
		/* 渐变方向为 135deg，后两项分别是起始色和结束色。 */
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--primary) 92%, white),
			#846bdc
		);
		color: white;
		/* 中央方块阴影：依次为横向偏移、纵向偏移、模糊半径和颜色。 */
		box-shadow: 0 1rem 2.5rem
			color-mix(in srgb, var(--primary) 28%, transparent);
		/* 中央方块逆时针倾斜角度；改为 0deg 即完全摆正。 */
		transform: rotate(0deg);
	}
	/* 盾牌图标自身的尺寸和角度。 */
	.auth-core :global(svg) {
		/* 盾牌图标宽度。 */
		width: 2.7rem;
		/* 盾牌图标高度。 */
		height: 2.7rem;
		/* 0deg，让盾牌图标保持竖直。 */
		transform: rotate(0deg);
	}
	/* ===== 红框动画手动校准区：结束 ===== */
	.github-login,
	.secondary-button,
	.icon-action,
	.console-tabs button,
	.filter-row button,
	.comment-actions button {
		border: 0;
		font: inherit;
		cursor: pointer;
	}
	.github-login {
		display: inline-flex;
		align-items: center;
		gap: 0.65rem;
		min-height: 3rem;
		padding: 0 1.25rem;
		border-radius: 1rem;
		background: #202632;
		color: white;
		font-weight: 700;
		box-shadow: 0 0.8rem 1.8rem rgb(32 38 50 / 20%);
		transition:
			transform 180ms ease,
			box-shadow 180ms ease;
	}
	.github-login:hover:not(:disabled) {
		transform: translateY(-2px);
		box-shadow: 0 1rem 2rem rgb(32 38 50 / 28%);
	}
	.github-login :global(svg) {
		width: 1.3rem;
		height: 1.3rem;
	}
	.auth-status,
	.loading-block {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.65rem;
		color: rgb(0 0 0 / 52%);
	}
	.spinner {
		display: inline-block;
		width: 1rem;
		height: 1rem;
		flex: 0 0 auto;
		border: 2px solid color-mix(in srgb, var(--primary) 22%, transparent);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: spin 0.75s linear infinite;
	}
	.auth-alert {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		max-width: 32rem;
		padding: 0.9rem 1rem;
		border: 1px solid color-mix(in srgb, #ef6a76 26%, transparent);
		border-radius: 1rem;
		background: color-mix(in srgb, #ef6a76 8%, transparent);
		color: #bd4654;
		text-align: left;
	}
	.auth-alert :global(svg) {
		width: 1.6rem;
		height: 1.6rem;
	}
	.auth-alert div {
		display: flex;
		flex-direction: column;
	}
	.auth-alert span {
		margin-top: 0.15rem;
		font-size: 0.75rem;
		opacity: 0.8;
	}
	.auth-actions {
		display: flex;
		gap: 0.65rem;
		margin-top: 1rem;
	}
	.secondary-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 2.5rem;
		padding: 0 0.9rem;
		border-radius: 0.8rem;
		background: var(--btn-regular-bg);
		color: rgb(0 0 0 / 68%);
		font-size: 0.78rem;
		font-weight: 700;
		transition:
			background 180ms ease,
			transform 180ms ease;
	}
	.secondary-button:hover:not(:disabled) {
		background: var(--btn-regular-bg-hover);
		transform: translateY(-1px);
	}
	.secondary-button.compact {
		min-height: 2.2rem;
	}
	.console-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.3rem 0.3rem 1.15rem;
	}
	.identity-block {
		display: flex;
		align-items: center;
		gap: 0.85rem;
		min-width: 0;
	}
	.identity-block img,
	.identity-icon {
		width: 3.5rem;
		height: 3.5rem;
		flex: 0 0 auto;
		border: 3px solid color-mix(in srgb, var(--primary) 24%, transparent);
		border-radius: 1.1rem;
		object-fit: cover;
	}
	.identity-icon {
		display: grid;
		place-items: center;
		color: var(--primary);
		background: color-mix(in srgb, var(--primary) 10%, transparent);
	}
	.identity-icon :global(svg) {
		width: 1.8rem;
		height: 1.8rem;
	}
	.identity-block h1 {
		margin: 0;
		color: rgb(0 0 0 / 84%);
		font-size: 1.65rem;
	}
	.identity-block p:last-child {
		margin: 0.2rem 0 0;
		color: rgb(0 0 0 / 44%);
		font-size: 0.76rem;
	}
	.console-actions {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}
	.sample-time {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.45rem 0.7rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--primary) 8%, transparent);
		color: rgb(0 0 0 / 50%);
		font-size: 0.68rem;
	}
	.sample-time :global(svg) {
		color: var(--primary);
	}
	.icon-action {
		display: grid;
		width: 2.6rem;
		height: 2.6rem;
		place-items: center;
		border-radius: 0.85rem;
		background: var(--btn-regular-bg);
		color: rgb(0 0 0 / 62%);
	}
	.icon-action:hover:not(:disabled) {
		background: var(--btn-regular-bg-hover);
		color: var(--primary);
	}
	.icon-action :global(svg) {
		width: 1.2rem;
		height: 1.2rem;
	}
	.spinning {
		animation: spin 0.8s linear infinite;
	}
	.console-tabs {
		display: flex;
		gap: 0.45rem;
		overflow-x: auto;
		padding: 0.35rem;
		border-radius: 1rem;
		background: color-mix(
			in srgb,
			var(--primary) 6%,
			var(--btn-regular-bg)
		);
	}
	.console-tabs button {
		position: relative;
		display: inline-flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-height: 2.8rem;
		min-width: 8.5rem;
		border-radius: 0.75rem;
		background: transparent;
		color: rgb(0 0 0 / 50%);
		font-weight: 700;
		transition: all 180ms ease;
	}
	.console-tabs button.active {
		background: var(--card-bg);
		color: var(--primary);
		box-shadow: 0 0.4rem 1.2rem rgb(0 0 0 / 7%);
	}
	.console-tabs button strong {
		min-width: 1.25rem;
		padding: 0.1rem 0.35rem;
		border-radius: 999px;
		background: #ef6a76;
		color: white;
		font-size: 0.63rem;
	}
	.toast {
		position: sticky;
		z-index: 10;
		top: 5.2rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: fit-content;
		max-width: 100%;
		margin: 0.8rem auto -0.1rem;
		padding: 0.65rem 0.9rem;
		border: 1px solid color-mix(in srgb, var(--primary) 22%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--card-bg) 92%, var(--primary) 8%);
		color: var(--primary);
		font-size: 0.75rem;
		box-shadow: 0 0.8rem 2rem rgb(0 0 0 / 10%);
	}
	.toast.success {
		color: #2e9f6b;
	}
	.toast.error {
		color: #d65464;
	}
	.tab-panel {
		padding-top: 1rem;
	}
	.content-panel[hidden] {
		display: none;
	}
	.kpi-grid {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 0.65rem;
	}
	.kpi-card {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
		padding: 0.85rem;
		border: 1px solid color-mix(in srgb, var(--primary) 10%, transparent);
		border-radius: 1rem;
		background: color-mix(in srgb, var(--card-bg) 95%, var(--primary) 2%);
	}
	.kpi-card > :global(svg) {
		width: 1.35rem;
		height: 1.35rem;
		flex: 0 0 auto;
		color: var(--primary);
	}
	.kpi-card div {
		display: flex;
		min-width: 0;
		flex-direction: column;
	}
	.kpi-card strong {
		color: rgb(0 0 0 / 80%);
		font-size: 1.1rem;
		font-variant-numeric: tabular-nums;
	}
	.kpi-card span {
		overflow: hidden;
		margin-top: 0.1rem;
		color: rgb(0 0 0 / 42%);
		font-size: 0.65rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.kpi-card.attention {
		border-color: color-mix(in srgb, #f2b84b 34%, transparent);
		background: color-mix(in srgb, #f2b84b 8%, var(--card-bg));
	}
	.kpi-card.attention > :global(svg),
	.kpi-card.attention strong {
		color: #cf8c17;
	}
	.section-card {
		margin-top: 0.8rem;
		padding: 1rem;
		border: 1px solid color-mix(in srgb, var(--primary) 11%, transparent);
		border-radius: 1.25rem;
		background: color-mix(in srgb, var(--card-bg) 96%, var(--primary) 1.5%);
	}
	.section-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.section-heading h2 {
		margin: 0;
		color: rgb(0 0 0 / 79%);
		font-size: 1.12rem;
	}
	.section-heading span {
		display: block;
		margin-top: 0.2rem;
		color: rgb(0 0 0 / 42%);
		font-size: 0.7rem;
	}
	.filter-row {
		display: flex;
		gap: 0.4rem;
		margin: 0.9rem 0;
		overflow-x: auto;
		padding-bottom: 0.15rem;
	}
	.filter-row button {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 0.35rem;
		min-height: 2.15rem;
		padding: 0 0.7rem;
		border-radius: 0.7rem;
		background: var(--btn-regular-bg);
		color: rgb(0 0 0 / 48%);
		font-size: 0.7rem;
	}
	.filter-row button.active {
		background: color-mix(in srgb, var(--primary) 14%, var(--card-bg));
		color: var(--primary);
	}
	.filter-row button strong {
		min-width: 1rem;
		padding: 0 0.25rem;
		border-radius: 999px;
		background: rgb(0 0 0 / 6%);
		font-size: 0.6rem;
		text-align: center;
	}
	.loading-block {
		min-height: 10rem;
	}
	.empty-state {
		display: flex;
		min-height: 13rem;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: rgb(0 0 0 / 35%);
	}
	.empty-state :global(svg) {
		width: 3rem;
		height: 3rem;
		color: color-mix(in srgb, var(--primary) 35%, transparent);
	}
	.empty-state h3 {
		margin: 0.65rem 0 0;
		color: rgb(0 0 0 / 58%);
	}
	.empty-state p {
		margin: 0.25rem 0 0;
		font-size: 0.72rem;
	}
	.comment-list {
		display: grid;
		gap: 0.65rem;
	}
	.comment-card {
		padding: 0.9rem;
		border: 1px solid rgb(0 0 0 / 7%);
		border-radius: 1rem;
		background: color-mix(in srgb, var(--card-bg) 97%, transparent);
	}
	.comment-card.pending {
		border-color: color-mix(in srgb, #f2b84b 28%, transparent);
	}
	.comment-card header {
		display: flex;
		align-items: center;
		gap: 0.65rem;
	}
	.comment-avatar {
		display: grid;
		width: 2.35rem;
		height: 2.35rem;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 0.75rem;
		background: color-mix(in srgb, var(--primary) 12%, transparent);
		color: var(--primary);
		font-weight: 800;
	}
	.comment-meta {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
	}
	.comment-meta strong {
		color: rgb(0 0 0 / 75%);
		font-size: 0.82rem;
	}
	.comment-meta span {
		overflow: hidden;
		margin-top: 0.12rem;
		color: rgb(0 0 0 / 40%);
		font-size: 0.65rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.comment-meta a {
		color: var(--primary);
		text-decoration: none;
	}
	.status-badge {
		flex: 0 0 auto;
		padding: 0.25rem 0.55rem;
		border-radius: 999px;
		background: rgb(0 0 0 / 5%);
		color: rgb(0 0 0 / 45%);
		font-size: 0.62rem;
		font-weight: 700;
	}
	.status-badge.pending {
		background: rgb(242 184 75 / 13%);
		color: #c48112;
	}
	.status-badge.approved {
		background: rgb(67 181 129 / 13%);
		color: #2f9b6b;
	}
	.status-badge.rejected {
		background: rgb(239 106 118 / 12%);
		color: #d65464;
	}
	.comment-body {
		margin: 0.8rem 0;
		padding: 0.75rem;
		border-radius: 0.8rem;
		background: rgb(0 0 0 / 2.5%);
		color: rgb(0 0 0 / 66%);
		font-size: 0.78rem;
		line-height: 1.75;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.moderation-note {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		color: rgb(0 0 0 / 45%);
		font-size: 0.68rem;
	}
	.comment-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}
	.comment-actions button {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		min-height: 2rem;
		padding: 0 0.65rem;
		border-radius: 0.65rem;
		background: var(--btn-regular-bg);
		color: rgb(0 0 0 / 52%);
		font-size: 0.67rem;
		font-weight: 700;
	}
	.comment-actions button.approve {
		color: #288c61;
	}
	.comment-actions button.reject,
	.comment-actions button.delete {
		color: #ca4c5c;
	}
	.comment-actions button:hover:not(:disabled) {
		background: var(--btn-regular-bg-hover);
		transform: translateY(-1px);
	}
	.inline-progress {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--primary);
		font-size: 0.65rem;
	}
	.audit-list {
		display: grid;
		margin-top: 0.8rem;
	}
	.audit-item {
		position: relative;
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 0.65rem;
		min-height: 3.3rem;
		border-bottom: 1px solid rgb(0 0 0 / 5%);
	}
	.audit-item:last-child {
		border-bottom: 0;
	}
	.audit-dot {
		width: 0.55rem;
		height: 0.55rem;
		border: 2px solid color-mix(in srgb, var(--primary) 25%, white);
		border-radius: 50%;
		background: var(--primary);
		box-shadow: 0 0 0.7rem
			color-mix(in srgb, var(--primary) 35%, transparent);
	}
	.audit-item div {
		min-width: 0;
	}
	.audit-item strong {
		color: rgb(0 0 0 / 68%);
		font-size: 0.73rem;
	}
	.audit-item p {
		margin: 0.1rem 0 0;
		color: rgb(0 0 0 / 38%);
		font-size: 0.62rem;
	}
	.audit-item time {
		color: rgb(0 0 0 / 36%);
		font-size: 0.62rem;
	}
	.empty-inline {
		padding: 2rem 0;
		color: rgb(0 0 0 / 40%);
		font-size: 0.72rem;
		text-align: center;
	}
	.status-banner {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		padding: 1rem;
		border: 1px solid color-mix(in srgb, #f2b84b 28%, transparent);
		border-radius: 1.25rem;
		background: linear-gradient(
			135deg,
			color-mix(in srgb, #f2b84b 8%, var(--card-bg)),
			var(--card-bg)
		);
	}
	.status-banner.healthy {
		border-color: color-mix(in srgb, #43b581 28%, transparent);
		background: linear-gradient(
			135deg,
			color-mix(in srgb, #43b581 9%, var(--card-bg)),
			var(--card-bg)
		);
	}
	.status-orb {
		position: relative;
		display: grid;
		width: 3.4rem;
		height: 3.4rem;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 1rem;
		background: rgb(242 184 75 / 13%);
		color: #d08c16;
	}
	.healthy .status-orb {
		background: rgb(67 181 129 / 13%);
		color: #2f9b6b;
	}
	.status-orb span {
		position: absolute;
		inset: -0.25rem;
		border: 1px solid currentcolor;
		border-radius: 1.15rem;
		opacity: 0.18;
		animation: pulse 2s ease-in-out infinite;
	}
	.status-orb :global(svg) {
		width: 1.75rem;
		height: 1.75rem;
	}
	.status-banner > div:nth-child(2) {
		min-width: 0;
		flex: 1;
	}
	.status-banner h2 {
		margin: 0;
		color: rgb(0 0 0 / 78%);
		font-size: 1.08rem;
	}
	.status-banner > div:nth-child(2) > span {
		display: block;
		margin-top: 0.2rem;
		color: rgb(0 0 0 / 42%);
		font-size: 0.7rem;
	}
	.rtt-block {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		padding-left: 1rem;
		border-left: 1px solid rgb(0 0 0 / 7%);
		white-space: nowrap;
	}
	.rtt-block span {
		color: rgb(0 0 0 / 42%);
		font-size: 0.65rem;
	}
	.rtt-block strong {
		margin-top: 0.15rem;
		color: var(--primary);
		font-size: 1.18rem;
		font-variant-numeric: tabular-nums;
	}
	.service-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.7rem;
		margin-top: 0.8rem;
	}
	.service-card {
		display: flex;
		gap: 0.7rem;
		min-width: 0;
		padding: 0.9rem;
		border: 1px solid color-mix(in srgb, #43b581 20%, transparent);
		border-radius: 1.15rem;
		background: color-mix(in srgb, #43b581 4%, var(--card-bg));
	}
	.service-card.down {
		border-color: color-mix(in srgb, #ef6a76 24%, transparent);
		background: color-mix(in srgb, #ef6a76 5%, var(--card-bg));
	}
	.service-card.degraded {
		border-color: color-mix(in srgb, #f2b84b 26%, transparent);
		background: color-mix(in srgb, #f2b84b 6%, var(--card-bg));
	}
	.service-icon {
		display: grid;
		width: 2.7rem;
		height: 2.7rem;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 0.85rem;
		background: rgb(67 181 129 / 12%);
		color: #2f9b6b;
	}
	.down .service-icon {
		background: rgb(239 106 118 / 12%);
		color: #d65464;
	}
	.service-card.degraded .service-icon {
		background: rgb(242 184 75 / 13%);
		color: #d08c16;
	}
	.service-icon :global(svg) {
		width: 1.4rem;
		height: 1.4rem;
	}
	.service-copy {
		min-width: 0;
		flex: 1;
	}
	.service-copy > div {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.35rem;
	}
	.service-copy h3 {
		overflow: hidden;
		margin: 0;
		color: rgb(0 0 0 / 74%);
		font-size: 0.78rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.service-copy > div span {
		color: #d65464;
		font-size: 0.6rem;
		font-weight: 700;
	}
	.service-copy > div span.online {
		color: #2f9b6b;
	}
	.service-copy > div span.degraded {
		color: #d08c16;
	}
	.service-copy > p {
		margin: 0.15rem 0 0.55rem;
		color: rgb(0 0 0 / 38%);
		font-size: 0.6rem;
	}
	.service-copy dl {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.35rem;
		margin: 0;
	}
	.service-copy dl div {
		display: flex;
		min-width: 0;
		flex-direction: column;
	}
	.service-copy dt {
		color: rgb(0 0 0 / 35%);
		font-size: 0.55rem;
	}
	.service-copy dd {
		overflow: hidden;
		margin: 0.08rem 0 0;
		color: rgb(0 0 0 / 65%);
		font-size: 0.65rem;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.monitoring-window {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) minmax(7rem, 10rem);
		align-items: center;
		gap: 0.7rem;
		margin-top: 0.65rem;
		padding: 0.7rem 0.85rem;
		border: 1px solid color-mix(in srgb, #43b581 20%, transparent);
		border-radius: 1rem;
		background: color-mix(in srgb, #43b581 4%, var(--card-bg));
	}
	.monitoring-window.collecting {
		border-color: color-mix(in srgb, #f2b84b 24%, transparent);
		background: color-mix(in srgb, #f2b84b 5%, var(--card-bg));
	}
	.monitoring-window.stale {
		border-color: color-mix(in srgb, #ef6a76 25%, transparent);
		background: color-mix(in srgb, #ef6a76 5%, var(--card-bg));
	}
	.monitoring-window-icon {
		display: grid;
		width: 2.25rem;
		height: 2.25rem;
		place-items: center;
		border-radius: 0.72rem;
		background: rgb(67 181 129 / 12%);
		color: #2f9b6b;
	}
	.collecting .monitoring-window-icon {
		background: rgb(242 184 75 / 13%);
		color: #d08c16;
	}
	.stale .monitoring-window-icon {
		background: rgb(239 106 118 / 12%);
		color: #d65464;
	}
	.monitoring-window-icon :global(svg) {
		width: 1.25rem;
		height: 1.25rem;
	}
	.monitoring-window-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
	}
	.monitoring-window-copy strong {
		color: rgb(0 0 0 / 72%);
		font-size: 0.72rem;
	}
	.monitoring-window-copy span {
		margin-top: 0.08rem;
		color: rgb(0 0 0 / 40%);
		font-size: 0.62rem;
	}
	.monitoring-progress {
		height: 0.42rem;
		overflow: hidden;
		border-radius: 999px;
		background: rgb(0 0 0 / 7%);
	}
	.monitoring-progress span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: #43b581;
		transition: width 300ms ease;
	}
	.collecting .monitoring-progress span {
		background: #f2b84b;
	}
	.stale .monitoring-progress span {
		background: #ef6a76;
	}
	.gauge-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.7rem;
		margin-top: 0.8rem;
	}
	.detail-grid,
	.chart-grid,
	.composition-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.8rem;
	}
	.metric-details {
		margin-top: 0.8rem;
	}
	.detail-list,
	.latency-stack {
		display: grid;
		gap: 0.2rem;
		margin-top: 0.75rem;
	}
	.detail-list > div,
	.latency-stack > div {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
		min-height: 2.5rem;
		padding: 0 0.65rem;
		border-radius: 0.7rem;
		background: rgb(0 0 0 / 2.3%);
	}
	.detail-list span {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: rgb(0 0 0 / 45%);
		font-size: 0.67rem;
	}
	.detail-list span :global(svg) {
		color: var(--primary);
	}
	.detail-list strong,
	.latency-stack strong {
		color: rgb(0 0 0 / 69%);
		font-size: 0.7rem;
		font-variant-numeric: tabular-nums;
	}
	.load-row {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.45rem;
		margin-top: 0.75rem;
	}
	.load-row div {
		display: flex;
		min-height: 4rem;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		border-radius: 0.85rem;
		background: color-mix(in srgb, var(--primary) 7%, transparent);
	}
	.load-row strong {
		color: var(--primary);
		font-size: 1.15rem;
		font-variant-numeric: tabular-nums;
	}
	.load-row span,
	.latency-stack span {
		color: rgb(0 0 0 / 40%);
		font-size: 0.6rem;
	}
	.chart-grid {
		margin-top: 0.8rem;
	}
	.composition-grid {
		margin-top: 0.8rem;
	}
	.composition-card {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-top: 0;
	}
	.pie-ring {
		display: grid;
		width: 8.5rem;
		height: 8.5rem;
		flex: 0 0 auto;
		place-items: center;
		padding: 0.75rem;
		border-radius: 50%;
	}
	.pie-ring > div {
		display: flex;
		width: 100%;
		height: 100%;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: var(--card-bg);
	}
	.pie-ring strong {
		color: rgb(0 0 0 / 78%);
		font-size: 1.35rem;
	}
	.pie-ring span {
		color: rgb(0 0 0 / 40%);
		font-size: 0.65rem;
	}
	.composition-copy {
		min-width: 0;
		flex: 1;
	}
	.composition-copy h2 {
		margin: 0;
		color: rgb(0 0 0 / 75%);
		font-size: 1rem;
	}
	.composition-copy ul {
		display: grid;
		gap: 0.35rem;
		margin: 0.65rem 0 0;
		padding: 0;
		list-style: none;
	}
	.composition-copy li {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 0.4rem;
		color: rgb(0 0 0 / 48%);
		font-size: 0.65rem;
	}
	.composition-copy li strong {
		color: rgb(0 0 0 / 68%);
	}
	.legend {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
	}
	.legend.primary {
		background: var(--primary);
	}
	.legend.purple {
		background: #8b78e6;
	}
	.legend.green {
		background: #43b581;
	}
	.legend.yellow {
		background: #f2b84b;
	}
	.legend.red {
		background: #ef6a76;
	}
	.legend.gray {
		background: #8792a2;
	}
	.data-source-note {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		margin: 0.8rem 0 0;
		padding: 0 0.2rem;
		color: rgb(0 0 0 / 38%);
		font-size: 0.62rem;
		line-height: 1.6;
	}
	.data-source-note :global(svg) {
		flex: 0 0 auto;
		margin-top: 0.08rem;
		color: #43b581;
	}
	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}
	:global(.dark) .auth-gate h1,
	:global(.dark) .identity-block h1,
	:global(.dark) .section-heading h2,
	:global(.dark) .status-banner h2,
	:global(.dark) .service-copy h3,
	:global(.dark) .monitoring-window-copy strong,
	:global(.dark) .composition-copy h2,
	:global(.dark) .pie-ring strong {
		color: rgb(255 255 255 / 88%);
	}
	:global(.dark) .auth-status,
	:global(.dark) .identity-block p:last-child,
	:global(.dark) .sample-time,
	:global(.dark) .section-heading span,
	:global(.dark) .status-banner > div:nth-child(2) > span,
	:global(.dark) .monitoring-window-copy span,
	:global(.dark) .rtt-block span,
	:global(.dark) .data-source-note {
		color: rgb(255 255 255 / 46%);
	}
	:global(.dark) .secondary-button,
	:global(.dark) .icon-action,
	:global(.dark) .console-tabs button,
	:global(.dark) .filter-row button,
	:global(.dark) .comment-actions button {
		color: rgb(255 255 255 / 68%);
	}
	:global(.dark) .console-tabs button.active {
		color: color-mix(in srgb, var(--primary) 82%, white);
	}
	:global(.dark) .kpi-card strong,
	:global(.dark) .comment-meta strong,
	:global(.dark) .audit-item strong,
	:global(.dark) .service-copy dd,
	:global(.dark) .detail-list strong,
	:global(.dark) .latency-stack strong,
	:global(.dark) .composition-copy li strong {
		color: rgb(255 255 255 / 76%);
	}
	:global(.dark) .kpi-card span,
	:global(.dark) .comment-meta span,
	:global(.dark) .audit-item p,
	:global(.dark) .audit-item time,
	:global(.dark) .service-copy > p,
	:global(.dark) .service-copy dt,
	:global(.dark) .detail-list span,
	:global(.dark) .load-row span,
	:global(.dark) .latency-stack span,
	:global(.dark) .composition-copy li {
		color: rgb(255 255 255 / 42%);
	}
	:global(.dark) .comment-body,
	:global(.dark) .detail-list > div,
	:global(.dark) .latency-stack > div {
		background: rgb(255 255 255 / 3.5%);
		color: rgb(255 255 255 / 70%);
	}
	/* 轨道旋转关键帧；轨道和加载圆圈共用，旋转速度在各自 animation 中调整。 */
	@keyframes spin {
		to {
			/* 一轮动画顺时针旋转 360 度。 */
			transform: rotate(360deg);
		}
	}
	@keyframes pulse {
		50% {
			transform: scale(1.12);
			opacity: 0;
		}
	}
	@media (max-width: 1180px) {
		.kpi-grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.gauge-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.service-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 760px) {
		.admin-shell {
			padding: 0.8rem;
		}
		.console-header {
			align-items: flex-start;
			flex-direction: column;
		}
		.console-actions {
			width: 100%;
		}
		.sample-time {
			flex: 1;
		}
		.kpi-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.detail-grid,
		.chart-grid,
		.composition-grid {
			grid-template-columns: 1fr;
		}
		.section-heading {
			align-items: flex-start;
			flex-direction: column;
		}
		.status-banner {
			align-items: flex-start;
			flex-wrap: wrap;
		}
		.rtt-block {
			width: 100%;
			align-items: flex-start;
			padding: 0.7rem 0 0;
			border-top: 1px solid rgb(0 0 0 / 7%);
			border-left: 0;
		}
		.service-copy dl {
			gap: 0.6rem;
		}
		.monitoring-window {
			grid-template-columns: auto minmax(0, 1fr);
		}
		.monitoring-progress {
			grid-column: 1 / -1;
		}
		.composition-card {
			justify-content: center;
		}
		.filter-row {
			margin-right: -0.4rem;
		}
		.comment-card header {
			align-items: flex-start;
		}
		.status-badge {
			margin-left: auto;
		}
		.comment-meta {
			flex: 0 1 auto;
		}
	}
	@media (max-width: 520px) {
		.auth-gate {
			/* 手机端登录区域高度。 */
			min-height: 30rem;
		}
		/* 手机端红框动画整体尺寸。 */
		.auth-orbit {
			/* 手机端动画宽度。 */
			width: 7.5rem;
			/* 手机端动画高度；应与宽度保持一致。 */
			height: 7.5rem;
		}
		/* 手机端中央盾牌方块尺寸。 */
		.auth-core {
			/* 手机端方块宽度。 */
			width: 4.5rem;
			/* 手机端方块高度；应与宽度保持一致。 */
			height: 4.5rem;
		}
		.console-tabs button {
			font-size: 0.75rem;
		}
		.gauge-grid {
			grid-template-columns: 1fr;
		}
		.kpi-card {
			padding: 0.7rem;
		}
		.comment-actions button {
			flex: 1;
			justify-content: center;
		}
		.composition-card {
			align-items: flex-start;
			flex-direction: column;
		}
		.pie-ring {
			align-self: center;
		}
		.audit-item {
			grid-template-columns: auto 1fr;
		}
		.audit-item time {
			grid-column: 2;
		}
		.github-login {
			width: 100%;
			justify-content: center;
		}
		.auth-actions {
			width: 100%;
			flex-direction: column;
		}
		.auth-actions button {
			width: 100%;
		}
	}
</style>
