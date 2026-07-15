import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL?.trim().replace(
	/\/+$/,
	"",
);
const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

export const isSupabaseBrowserConfigured = Boolean(
	supabaseUrl && publishableKey,
);

let browserClient: SupabaseClient | null = null;
const fallbackSessionStorage = new Map<string, string>();

const adminSessionStorage = {
	getItem(key: string): string | null {
		try {
			return window.sessionStorage.getItem(key);
		} catch {
			return fallbackSessionStorage.get(key) ?? null;
		}
	},
	setItem(key: string, value: string): void {
		try {
			window.sessionStorage.setItem(key, value);
		} catch {
			fallbackSessionStorage.set(key, value);
		}
	},
	removeItem(key: string): void {
		try {
			window.sessionStorage.removeItem(key);
		} catch {
			fallbackSessionStorage.delete(key);
		}
	},
};

/**
 * Returns the single browser-side Supabase client used by the admin session.
 *
 * The public URL and publishable key are intentionally safe to ship to the
 * browser. Server/secret keys must never be added here.
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
	if (typeof window === "undefined" || !supabaseUrl || !publishableKey) {
		return null;
	}

	if (!browserClient) {
		browserClient = createClient(supabaseUrl, publishableKey, {
			auth: {
				autoRefreshToken: true,
				detectSessionInUrl: true,
				flowType: "pkce",
				persistSession: true,
				storage: adminSessionStorage,
			},
		});
	}

	return browserClient;
}
