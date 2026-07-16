<script lang="ts">
	export let icon = "";

	type IconGroup =
		| "add"
		| "article"
		| "back"
		| "category"
		| "check"
		| "close"
		| "copy"
		| "edit"
		| "eye"
		| "eye-off"
		| "folder"
		| "globe"
		| "image"
		| "info"
		| "label"
		| "link"
		| "lock"
		| "merge"
		| "move"
		| "pin"
		| "publish"
		| "restore"
		| "save"
		| "science"
		| "search"
		| "search-off"
		| "split"
		| "trash"
		| "warning";

	function resolveGroup(value: string): IconGroup {
		const name = value.split(":").at(-1) ?? value;
		if (name.startsWith("close")) return "close";
		if (name.startsWith("add") || name.startsWith("new-label"))
			return "add";
		if (name.startsWith("arrow-back")) return "back";
		if (name.startsWith("article") || name.startsWith("edit-note"))
			return "article";
		if (name.startsWith("category")) return "category";
		if (name.startsWith("folder")) return "folder";
		if (name.startsWith("label")) return "label";
		if (name.startsWith("delete")) return "trash";
		if (name.startsWith("restart") || name.startsWith("restore"))
			return "restore";
		if (name.startsWith("check")) return "check";
		if (name.startsWith("warning")) return "warning";
		if (name.startsWith("info")) return "info";
		if (name.startsWith("science")) return "science";
		if (name.startsWith("public")) return "globe";
		if (name.startsWith("visibility-off")) return "eye-off";
		if (name.startsWith("visibility")) return "eye";
		if (name.startsWith("push-pin")) return "pin";
		if (name.startsWith("search-off")) return "search-off";
		if (name.startsWith("search")) return "search";
		if (name.startsWith("publish") || name.startsWith("rocket"))
			return "publish";
		if (name.startsWith("drive-file-move")) return "move";
		if (name.startsWith("merge")) return "merge";
		if (name.startsWith("edit")) return "edit";
		if (name.startsWith("content-copy")) return "copy";
		if (name.startsWith("save")) return "save";
		if (name.startsWith("vertical-split")) return "split";
		if (name.startsWith("image")) return "image";
		if (name.startsWith("link")) return "link";
		if (name.startsWith("lock")) return "lock";
		return "info";
	}

	$: group = resolveGroup(icon);
</script>

<svg
	class="admin-icon"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.9"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
>
	{#if group === "add"}
		<path d="M12 5v14M5 12h14" />
	{:else if group === "back"}
		<path d="m15 18-6-6 6-6M9 12h10" />
	{:else if group === "article"}
		<path d="M6 3.5h8l4 4V20H6zM14 3.5V8h4M9 12h6M9 15.5h6" />
	{:else if group === "category"}
		<path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z" />
	{:else if group === "folder"}
		<path d="M3.5 7.5h6l2-2h9v13h-17z" />
	{:else if group === "label"}
		<path d="M4 6h10l6 6-6 6H4z" />
		<circle cx="8" cy="12" r="1" />
	{:else if group === "trash"}
		<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
	{:else if group === "restore"}
		<path d="M5 8V4m0 0h4M5 4l3 3a7 7 0 1 1-2 7" />
	{:else if group === "check"}
		<path d="m5 12 4 4 10-10" />
	{:else if group === "warning"}
		<path d="M12 3 2.8 20h18.4zM12 9v5M12 17.5h.01" />
	{:else if group === "info"}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 11v6M12 7h.01" />
	{:else if group === "science"}
		<path
			d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9"
		/>
	{:else if group === "globe"}
		<circle cx="12" cy="12" r="9" />
		<path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
	{:else if group === "eye"}
		<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6" />
		<circle cx="12" cy="12" r="2.5" />
	{:else if group === "eye-off"}
		<path
			d="M3 3l18 18M10.5 6.2Q11.2 6 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.2 3M6.2 7.1A17 17 0 0 0 2.5 12s3.5 6 9.5 6q1.5 0 2.8-.5"
		/>
	{:else if group === "pin"}
		<path d="M8 4h8l-1.5 5 3 3H6.5l3-3zM12 12v8" />
	{:else if group === "search"}
		<circle cx="10.5" cy="10.5" r="6.5" />
		<path d="m15.5 15.5 5 5" />
	{:else if group === "search-off"}
		<circle cx="10.5" cy="10.5" r="6.5" />
		<path d="m15.5 15.5 5 5M4 4l16 16" />
	{:else if group === "publish"}
		<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v6h14v-6" />
	{:else if group === "move"}
		<path d="M3.5 7.5h6l2-2h9v13h-17zM9 12h7m0 0-2.5-2.5M16 12l-2.5 2.5" />
	{:else if group === "merge"}
		<path
			d="M5 5h3a4 4 0 0 1 4 4v10M5 19h3a4 4 0 0 0 4-4V9a4 4 0 0 1 4-4h3M16 2l3 3-3 3"
		/>
	{:else if group === "edit"}
		<path d="m4 20 4.5-1 10-10-3.5-3.5-10 10zM13.8 6.7l3.5 3.5" />
	{:else if group === "copy"}
		<path d="M8 8h11v11H8zM5 16H4V5h11v1" />
	{:else if group === "save"}
		<path d="M5 4h12l2 2v14H5zM8 4v5h8V4M8 20v-7h8v7" />
	{:else if group === "split"}
		<path d="M4 5h16v14H4zM12 5v14M7 9h2M7 13h2M15 9h2M15 13h2" />
	{:else if group === "image"}
		<path d="M4 5h16v14H4zM6 17l4-4 3 3 2-2 3 3M9 9h.01" />
	{:else if group === "link"}
		<path
			d="M10 14 8.5 15.5a3.5 3.5 0 0 1-5-5L6 8M14 10l1.5-1.5a3.5 3.5 0 0 1 5 5L18 16M8 12h8"
		/>
	{:else if group === "lock"}
		<path d="M6 10h12v10H6zM8.5 10V7.5a3.5 3.5 0 0 1 7 0V10M12 14v2" />
	{:else if group === "close"}
		<path d="m6 6 12 12M18 6 6 18" />
	{/if}
</svg>

<style>
	.admin-icon {
		display: block;
		width: 1em;
		height: 1em;
		flex: 0 0 auto;
		overflow: visible;
	}
</style>
