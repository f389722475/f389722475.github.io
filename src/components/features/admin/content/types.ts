import type {
	AdminContentPost,
	AdminContentPostKind,
	AdminContentPostStatus,
} from "@/lib/supabase";

export type StudioPostStatus = AdminContentPostStatus;
export type StudioPostKind = AdminContentPostKind;

export type StudioView = "posts" | "editor" | "taxonomy" | "trash";
export type TaxonomyKind = "category" | "tag";

export type StudioPost = AdminContentPost;

export interface StudioTaxonomyItem {
	name: string;
	count: number;
}
