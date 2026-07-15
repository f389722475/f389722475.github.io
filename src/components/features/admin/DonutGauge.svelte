<script lang="ts">
	import Icon from "@iconify/svelte";

	export let label: string;
	export let value: number | null = null;
	export let detail = "";
	export let icon = "material-symbols:monitoring-rounded";
	export let warningAt = 60;
	export let criticalAt = 85;

	$: normalized =
		value === null || !Number.isFinite(value)
			? null
			: Math.min(100, Math.max(0, value));
	$: tone =
		normalized === null
			? "muted"
			: normalized >= criticalAt
				? "critical"
				: normalized >= warningAt
					? "warning"
					: "healthy";
	$: ringStyle = `--gauge-value: ${normalized ?? 0};`;
</script>

<article
	class="gauge-card"
	class:warning={tone === "warning"}
	class:critical={tone === "critical"}
>
	<div class="gauge-ring" class:empty={normalized === null} style={ringStyle}>
		<div class="gauge-center">
			<Icon {icon} />
			<strong
				>{normalized === null
					? "暂无"
					: `${normalized.toFixed(1)}%`}</strong
			>
		</div>
	</div>
	<div class="gauge-copy">
		<h3>{label}</h3>
		<p>{detail || (normalized === null ? "暂无可用样本" : "实时采样")}</p>
	</div>
</article>

<style>
	.gauge-card {
		display: flex;
		align-items: center;
		gap: 1rem;
		min-width: 0;
		padding: 1rem;
		border: 1px solid color-mix(in srgb, var(--primary) 12%, transparent);
		border-radius: 1.25rem;
		background: color-mix(in srgb, var(--card-bg) 90%, var(--primary) 3%);
	}

	.gauge-ring {
		--gauge-color: #43b581;
		width: 6.2rem;
		height: 6.2rem;
		padding: 0.55rem;
		border-radius: 999px;
		background: conic-gradient(
			var(--gauge-color) calc(var(--gauge-value) * 1%),
			color-mix(in srgb, var(--gauge-color) 12%, transparent) 0
		);
		box-shadow: 0 0 1.5rem
			color-mix(in srgb, var(--gauge-color) 16%, transparent);
		flex: 0 0 auto;
	}

	.gauge-ring.empty {
		--gauge-color: #94a3b8;
	}

	.warning .gauge-ring {
		--gauge-color: #f2b84b;
	}

	.critical .gauge-ring {
		--gauge-color: #ef6a76;
	}

	.gauge-center {
		display: flex;
		width: 100%;
		height: 100%;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.1rem;
		border-radius: inherit;
		background: var(--card-bg);
		color: color-mix(in srgb, var(--gauge-color) 82%, #1f2937);
	}

	.gauge-center :global(svg) {
		width: 1.25rem;
		height: 1.25rem;
	}

	.gauge-center strong {
		font-size: 1rem;
		font-variant-numeric: tabular-nums;
	}

	.gauge-copy {
		min-width: 0;
	}

	.gauge-copy h3 {
		margin: 0;
		font-size: 0.96rem;
		color: rgb(0 0 0 / 78%);
	}

	.gauge-copy p {
		margin: 0.35rem 0 0;
		font-size: 0.74rem;
		line-height: 1.45;
		color: rgb(0 0 0 / 46%);
	}

	:global(.dark) .gauge-copy h3 {
		color: rgb(255 255 255 / 84%);
	}

	:global(.dark) .gauge-copy p {
		color: rgb(255 255 255 / 48%);
	}

	@media (max-width: 420px) {
		.gauge-card {
			flex-direction: column;
			text-align: center;
		}
	}
</style>
