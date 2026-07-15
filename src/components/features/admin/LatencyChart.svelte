<script lang="ts">
	export interface LatencyPoint {
		checkedAt: string;
		latencyMs: number | null;
		status: "up" | "degraded" | "down" | string;
	}
	interface TimestampedPoint extends LatencyPoint {
		timestamp: number;
	}
	interface PlottedPoint extends TimestampedPoint {
		x: number;
		y: number;
	}

	export let points: LatencyPoint[] = [];
	export let label = "24 小时响应延迟";
	export let color = "var(--primary)";
	export let intervalMinutes = 10;
	export let sampleCount = 0;
	export let expectedSamples = 144;
	export let coveragePercent = 0;
	export let lastMonitorAt: string | null = null;
	export let stale = false;
	export let ready = false;

	const width = 640;
	const height = 190;
	const insetX = 18;
	const insetY = 22;
	const windowMs = 24 * 60 * 60 * 1000;

	function stableId(value: string): string {
		let hash = 0;
		for (let index = 0; index < value.length; index += 1) {
			hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
		}
		return `latency-area-${hash.toString(36)}`;
	}

	function splitSegments(
		values: PlottedPoint[],
		gapThresholdMs: number,
	): PlottedPoint[][] {
		const result: PlottedPoint[][] = [];
		for (const point of values) {
			const current = result.at(-1);
			const previous = current?.at(-1);
			if (
				!current ||
				(previous &&
					point.timestamp - previous.timestamp > gapThresholdMs)
			) {
				result.push([point]);
			} else {
				current.push(point);
			}
		}
		return result;
	}

	function pathFor(segment: PlottedPoint[]): string {
		return segment
			.map(
				(point, index) =>
					`${index === 0 ? "M" : "L"}${point.x},${point.y}`,
			)
			.join(" ");
	}

	$: orderedPoints = points
		.map((point) => ({
			...point,
			timestamp: new Date(point.checkedAt).getTime(),
		}))
		.filter((point): point is TimestampedPoint =>
			Number.isFinite(point.timestamp),
		)
		.sort((left, right) => left.timestamp - right.timestamp);
	$: validPoints = orderedPoints.filter(
		(point) => point.latencyMs !== null && Number.isFinite(point.latencyMs),
	);
	$: windowEnd = Math.max(
		Date.now(),
		...orderedPoints.map((point) => point.timestamp),
	);
	$: windowStart = windowEnd - windowMs;
	$: maxValue = Math.max(
		100,
		...validPoints.map((point) => Number(point.latencyMs)),
	);
	$: plotted = validPoints.map<PlottedPoint>((point) => ({
		...point,
		x:
			insetX +
			Math.max(
				0,
				Math.min(1, (point.timestamp - windowStart) / windowMs),
			) *
				(width - insetX * 2),
		y:
			height -
			insetY -
			(Number(point.latencyMs) / maxValue) * (height - insetY * 2),
	}));
	$: gapThresholdMs = Math.max(1, intervalMinutes) * 60 * 1000 * 2.5;
	$: plottedSegments = splitSegments(plotted, gapThresholdMs);
	$: gapMarkers = orderedPoints
		.slice(1)
		.map((point, index) => ({
			left: orderedPoints[index],
			right: point,
		}))
		.filter(
			({ left, right }) =>
				right.timestamp - left.timestamp > gapThresholdMs,
		)
		.map(({ left, right }) => ({
			x:
				insetX +
				Math.max(
					0,
					Math.min(
						1,
						((left.timestamp + right.timestamp) / 2 - windowStart) /
							windowMs,
					),
				) *
					(width - insetX * 2),
			minutes: Math.round((right.timestamp - left.timestamp) / 60_000),
		}));
	$: latestPoint = orderedPoints.at(-1);
	$: latest =
		latestPoint?.latencyMs !== null &&
		latestPoint?.latencyMs !== undefined &&
		Number.isFinite(latestPoint.latencyMs)
			? latestPoint.latencyMs
			: null;
	$: failed = orderedPoints.filter((point) => point.status === "down").length;
	$: degraded = orderedPoints.filter(
		(point) => point.status === "degraded",
	).length;
	$: issueParts = [
		failed > 0 ? `${failed} 次异常` : "",
		degraded > 0 ? `${degraded} 次降级` : "",
		gapMarkers.length > 0 ? `${gapMarkers.length} 处断档` : "",
	].filter(Boolean);
	$: statusSummary = stale
		? "监控中断"
		: issueParts.length > 0
			? issueParts.join(" · ")
			: ready
				? "状态稳定"
				: "数据积累中";
	$: sampleSummary = `${sampleCount}/${expectedSamples} 个定时样本 · 覆盖 ${coveragePercent.toFixed(2)}%`;
	$: gradientId = stableId(label);
</script>

<article class="chart-card">
	<header>
		<div>
			<h3>{label}</h3>
			<p>{sampleSummary}</p>
		</div>
		<div class="latest-value">
			<strong
				>{latest === null
					? "暂无"
					: `${Math.round(Number(latest))} ms`}</strong
			>
			<span
				class:has-failure={failed > 0 || stale}
				class:has-warning={failed === 0 &&
					!stale &&
					(degraded > 0 || gapMarkers.length > 0 || !ready)}
				>{statusSummary}</span
			>
		</div>
	</header>

	<div class="chart-stage" aria-label={`${label}趋势图`}>
		{#if plotted.length > 0}
			<svg viewBox={`0 0 ${width} ${height}`} role="img">
				<title>{label}</title>
				<defs>
					<linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
						<stop
							offset="0"
							stop-color={color}
							stop-opacity="0.26"
						/>
						<stop offset="1" stop-color={color} stop-opacity="0" />
					</linearGradient>
				</defs>
				<line
					x1={insetX}
					x2={width - insetX}
					y1={height - insetY}
					y2={height - insetY}
					class="axis"
				/>
				<line
					x1={insetX}
					x2={width - insetX}
					y1={height / 2}
					y2={height / 2}
					class="grid-line"
				/>
				<text x={insetX} y={height - 4} class="axis-label"
					>24 小时前</text
				>
				<text
					x={width - insetX}
					y={height - 4}
					text-anchor="end"
					class="axis-label">现在</text
				>
				{#each gapMarkers as gap}
					<line
						x1={gap.x}
						x2={gap.x}
						y1={insetY}
						y2={height - insetY}
						class="gap-marker"
					>
						<title>监控断档约 {gap.minutes} 分钟</title>
					</line>
				{/each}
				{#each plottedSegments as segment}
					{@const segmentPath = pathFor(segment)}
					{#if segment.length > 1}
						<path
							d={`${segmentPath} L${segment.at(-1)?.x},${height - insetY} L${segment[0]?.x},${height - insetY} Z`}
							fill={`url(#${gradientId})`}
						/>
						<path
							d={segmentPath}
							fill="none"
							stroke={color}
							stroke-width="4"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					{/if}
				{/each}
				{#each plotted as point}
					<circle
						cx={point.x}
						cy={point.y}
						r={point.status === "down" ? 5 : 3}
						class:failed-point={point.status === "down"}
						class:degraded-point={point.status === "degraded"}
						fill={point.status === "down"
							? "#ef6a76"
							: point.status === "degraded"
								? "#f2b84b"
								: color}
					>
						<title
							>{new Date(point.checkedAt).toLocaleString("zh-CN")} ·
							{point.status === "down"
								? "异常"
								: point.status === "degraded"
									? "降级"
									: "正常"} · {Math.round(
								Number(point.latencyMs),
							)} ms</title
						>
					</circle>
				{/each}
			</svg>
		{:else}
			<div class="empty-chart">
				<span></span><span></span><span></span><span></span><span
				></span>
				<p>
					{stale
						? `定时监控已中断${lastMonitorAt ? `，最后样本 ${new Date(lastMonitorAt).toLocaleString("zh-CN")}` : ""}`
						: "等待定时探测样本"}
				</p>
			</div>
		{/if}
	</div>
</article>

<style>
	.chart-card {
		padding: 1.1rem;
		border: 1px solid color-mix(in srgb, var(--primary) 12%, transparent);
		border-radius: 1.25rem;
		background: color-mix(in srgb, var(--card-bg) 94%, var(--primary) 2%);
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	header h3 {
		margin: 0;
		font-size: 1rem;
		color: rgb(0 0 0 / 78%);
	}

	header p,
	.latest-value span {
		margin: 0.25rem 0 0;
		font-size: 0.72rem;
		color: rgb(0 0 0 / 44%);
	}

	.latest-value {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		white-space: nowrap;
	}

	.latest-value strong {
		font-size: 1.1rem;
		font-variant-numeric: tabular-nums;
		color: var(--primary);
	}

	.latest-value span.has-failure {
		color: #ef6a76;
	}
	.latest-value span.has-warning {
		color: #d08c16;
	}

	.chart-stage {
		min-height: 12rem;
		margin-top: 0.8rem;
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
	}

	.axis,
	.grid-line {
		stroke: rgb(0 0 0 / 9%);
		stroke-width: 1;
		stroke-dasharray: 6 7;
	}
	.axis-label {
		fill: rgb(0 0 0 / 34%);
		font-size: 10px;
	}
	.gap-marker {
		stroke: #f2b84b;
		stroke-width: 1.5;
		stroke-dasharray: 4 5;
		opacity: 0.72;
	}

	.failed-point {
		filter: drop-shadow(0 0 5px rgb(239 106 118 / 65%));
	}
	.degraded-point {
		filter: drop-shadow(0 0 5px rgb(242 184 75 / 58%));
	}

	.empty-chart {
		position: relative;
		display: flex;
		height: 12rem;
		align-items: flex-end;
		justify-content: center;
		gap: 0.65rem;
		padding-bottom: 2.4rem;
		border-radius: 1rem;
		background: linear-gradient(
			180deg,
			transparent,
			color-mix(in srgb, var(--primary) 5%, transparent)
		);
	}

	.empty-chart span {
		width: 0.7rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--primary) 18%, transparent);
	}

	.empty-chart span:nth-child(1) {
		height: 24%;
	}
	.empty-chart span:nth-child(2) {
		height: 41%;
	}
	.empty-chart span:nth-child(3) {
		height: 31%;
	}
	.empty-chart span:nth-child(4) {
		height: 56%;
	}
	.empty-chart span:nth-child(5) {
		height: 45%;
	}

	.empty-chart p {
		position: absolute;
		bottom: 0.65rem;
		margin: 0;
		font-size: 0.72rem;
		color: rgb(0 0 0 / 42%);
	}

	:global(.dark) header h3 {
		color: rgb(255 255 255 / 84%);
	}

	:global(.dark) header p,
	:global(.dark) .latest-value span,
	:global(.dark) .empty-chart p {
		color: rgb(255 255 255 / 46%);
	}

	:global(.dark) .axis,
	:global(.dark) .grid-line {
		stroke: rgb(255 255 255 / 11%);
	}
	:global(.dark) .axis-label {
		fill: rgb(255 255 255 / 38%);
	}

	@media (max-width: 520px) {
		header {
			flex-direction: column;
		}
		.latest-value {
			align-items: flex-start;
		}
	}
</style>
