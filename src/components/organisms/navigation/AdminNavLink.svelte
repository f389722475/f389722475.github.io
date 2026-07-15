<script lang="ts">
	import Icon from "@iconify/svelte";
	import type { Session } from "@supabase/supabase-js";
	import { onMount } from "svelte";

	import {
		getAdminMe,
		getSupabaseBrowserClient,
		isAdminApiConfigured,
	} from "@/lib/supabase";

	export let href = "/admin/";
	export let variant: "desktop" | "mobile" = "desktop";

	let visible = false;

	onMount(() => {
		const supabase = getSupabaseBrowserClient();
		if (!supabase || !isAdminApiConfigured) {
			return;
		}

		let disposed = false;
		let verificationVersion = 0;
		let verificationController: AbortController | null = null;

		const verifySession = async (session: Session | null) => {
			const currentVersion = ++verificationVersion;
			verificationController?.abort();
			verificationController = null;
			visible = false;

			if (!session?.access_token) {
				return;
			}

			const controller = new AbortController();
			verificationController = controller;
			try {
				const me = await getAdminMe(
					session.access_token,
					controller.signal,
				);
				if (!disposed && currentVersion === verificationVersion) {
					visible = me.isAdmin === true;
				}
			} catch {
				if (!disposed && currentVersion === verificationVersion) {
					visible = false;
				}
			}
		};

		const {
			data: { subscription },
		} = supabase.auth.onAuthStateChange((_event, session) => {
			void verifySession(session);
		});

		void supabase.auth
			.getSession()
			.then(({ data }) => verifySession(data.session))
			.catch(() => {
				visible = false;
			});

		return () => {
			disposed = true;
			verificationVersion += 1;
			verificationController?.abort();
			subscription.unsubscribe();
		};
	});
</script>

{#if visible}
	{#if variant === "mobile"}
		<div class="mobile-menu-item">
			<a
				{href}
				class="group flex justify-between items-center py-2 pl-3 pr-1 rounded-lg gap-4 hover:bg-[var(--btn-plain-bg-hover)] active:bg-[var(--btn-plain-bg-active)] transition"
				aria-label="管理员后台"
			>
				<div
					class="flex items-center transition text-black/75 dark:text-white/75 font-bold"
				>
					<Icon
						icon="material-symbols:admin-panel-settings-outline-rounded"
						class="text-[1.1rem] mr-2"
					/>
					管理员后台
				</div>
				<Icon
					icon="material-symbols:chevron-right-rounded"
					class="transition text-[1.25rem] text-[var(--primary)]"
				/>
			</a>
		</div>
	{:else}
		<a
			{href}
			class="btn-plain scale-animation rounded-lg h-11 font-bold w-11 lg:w-auto lg:px-5 active:scale-95 flex items-center justify-center lg:justify-start whitespace-nowrap"
			aria-label="管理员后台"
		>
			<Icon
				icon="material-symbols:admin-panel-settings-outline-rounded"
				class="text-[1.1rem] lg:mr-2 flex-shrink-0"
			/>
			<span class="truncate hidden lg:inline">管理员后台</span>
		</a>
	{/if}
{/if}
