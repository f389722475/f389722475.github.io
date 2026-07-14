// Project data configuration file
// Used to manage data for the project display page

export interface Project {
	id: string;
	title: string;
	description: string;
	image: string;
	category: "web" | "mobile" | "desktop" | "other";
	techStack: string[];
	status: "completed" | "in-progress" | "planned";
	liveDemo?: string;
	sourceCode?: string;
	visitUrl?: string;
	startDate: string;
	endDate?: string;
	featured?: boolean;
	tags?: string[];
	showImage?: boolean;
}

export const projectsData: Project[] = [
	{
		id: "mizuki",
		title: "Mizuki",
		description:
			"使用 Astro 构建的下一代 Material Design 3 博客主题，支持国际化、深色模式和响应式设计。",
		image: "/assets/projects/mizuki.webp",
		category: "web",
		techStack: ["Astro", "TypeScript", "Tailwind CSS", "Svelte"],
		status: "completed",
		sourceCode: "https://github.com/matsuzaka-yuki/Mizuki",
		visitUrl: "https://mizuki.mysqil.com",
		startDate: "2024-01-01",
		endDate: "2024-06-01",
		featured: true,
		tags: ["博客", "主题", "开源"],
	},
	{
		id: "folkpatch",
		title: "FolkPatch",
		description:
			"基于 KernelPatch 的内核级 ROOT 解决方案，拥有精致的用户界面、APM 模块系统和 KPM 内核模块支持。",
		image: "/assets/projects/folkpatch.webp",
		category: "mobile",
		techStack: ["Kotlin", "Rust", "C++", "Java"],
		status: "in-progress",
		sourceCode: "https://github.com/matsuzaka-yuki/FolkPatch",
		visitUrl: "https://fp.mysqil.com",
		startDate: "2024-03-01",
		featured: true,
		tags: ["Android", "ROOT", "内核"],
	},
	{
		id: "folktool",
		title: "FolkTool",
		description:
			"面向 FolkPatch 的快速 ROOT 刷写工具，提供图形界面和自动化操作，简化复杂的刷写流程。",
		image: "",
		category: "desktop",
		techStack: ["Flutter", "Dart", "C++", "CMake"],
		status: "completed",
		sourceCode: "https://github.com/matsuzaka-yuki/FolkTool",
		startDate: "2026-02-01",
		endDate: "2026-02-28",
		tags: ["Android", "工具", "桌面端"],
		showImage: false,
	},
	{
		id: "folkadb",
		title: "FolkADB",
		description:
			"使用 C 编写的便携式 ADB/Fastboot 工具，支持交互式 CLI、Tab 补全、拖放安装模块和激活 Shizuku。",
		image: "",
		category: "desktop",
		techStack: ["C"],
		status: "completed",
		sourceCode: "https://github.com/matsuzaka-yuki/FolkADB",
		startDate: "2025-06-01",
		endDate: "2026-01-01",
		tags: ["Android", "ADB", "CLI"],
		showImage: false,
	},
	{
		id: "folksplash",
		title: "FolkSplash",
		description:
			"面向 OPPO/Realme/OnePlus 设备的网页端 splash.img 可视化工具，支持解包、预览、替换和重新打包。",
		image: "",
		category: "web",
		techStack: ["React", "TypeScript", "Vite", "Material-UI", "Zustand"],
		status: "completed",
		sourceCode: "https://github.com/matsuzaka-yuki/FolkSplash",
		visitUrl: "https://splash.mysqil.com",
		startDate: "2025-09-01",
		endDate: "2025-10-01",
		tags: ["Android", "工具", "前端"],
		showImage: false,
	},
];

// Get project statistics
export const getProjectStats = () => {
	const total = projectsData.length;
	const completed = projectsData.filter(
		(p) => p.status === "completed",
	).length;
	const inProgress = projectsData.filter(
		(p) => p.status === "in-progress",
	).length;
	const planned = projectsData.filter((p) => p.status === "planned").length;

	return {
		total,
		byStatus: {
			completed,
			inProgress,
			planned,
		},
	};
};

// Get projects by category
export const getProjectsByCategory = (category?: string) => {
	if (!category || category === "all") {
		return projectsData;
	}
	return projectsData.filter((p) => p.category === category);
};

// Get featured projects
export const getFeaturedProjects = () => {
	return projectsData.filter((p) => p.featured);
};

// Get all tech stacks
export const getAllTechStack = () => {
	const techSet = new Set<string>();
	projectsData.forEach((project) => {
		project.techStack.forEach((tech) => {
			techSet.add(tech);
		});
	});
	return Array.from(techSet).sort();
};
