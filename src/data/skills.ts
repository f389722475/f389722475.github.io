// Skill data configuration file
// Used to manage data for the skill display page

export interface Skill {
	id: string;
	name: string;
	description: string;
	icon: string; // Iconify icon name
	category: "frontend" | "backend" | "database" | "tools" | "other";
	level: "beginner" | "intermediate" | "advanced" | "expert";
	progress: number;
	projects?: string[]; // Related project IDs
	certifications?: string[];
	color?: string; // Skill card theme color
}

export const skillsData: Skill[] = [
	{
		id: "javascript",
		name: "JavaScript",
		description:
			"现代 JavaScript 开发，包括 ES6+ 语法、异步编程和模块化开发。",
		icon: "logos:javascript",
		category: "frontend",
		level: "advanced",
		progress: 82,
		color: "#F7DF1E",
	},
	{
		id: "typescript",
		name: "TypeScript",
		description: "JavaScript 的类型安全超集，可提升代码质量和开发效率。",
		icon: "logos:typescript-icon",
		category: "frontend",
		level: "beginner",
		progress: 35,
		color: "#3178C6",
	},
	{
		id: "rust",
		name: "Rust",
		description: "注重安全、性能和并发能力的现代系统编程语言。",
		icon: "logos:rust",
		category: "backend",
		level: "beginner",
		progress: 40,
		color: "#CE422B",
	},
	{
		id: "nodejs",
		name: "Node.js",
		description:
			"基于 Chrome V8 引擎的 JavaScript 运行时，用于服务端和工具开发。",
		icon: "logos:nodejs-icon",
		category: "backend",
		level: "intermediate",
		progress: 55,
		color: "#339933",
	},
	{
		id: "tailwindcss",
		name: "Tailwind CSS",
		description: "实用优先的 CSS 框架，可快速构建现代响应式界面。",
		icon: "logos:tailwindcss-icon",
		category: "frontend",
		level: "intermediate",
		progress: 52,
		color: "#06B6D4",
	},
	{
		id: "react",
		name: "React",
		description:
			"用于构建用户界面的 JavaScript 库，包括组件、Hooks 和状态管理。",
		icon: "logos:react",
		category: "frontend",
		level: "advanced",
		progress: 75,
		color: "#61DAFB",
	},
	{
		id: "python",
		name: "Python",
		description: "通用编程语言，适用于自动化、工具开发与数据处理。",
		icon: "logos:python",
		category: "backend",
		level: "intermediate",
		progress: 68,
		color: "#3776AB",
	},
	{
		id: "kotlin",
		name: "Kotlin",
		description:
			"与 Java 生态兼容的现代编程语言，可用于 Android 与 JVM 开发。",
		icon: "logos:kotlin-icon",
		category: "backend",
		level: "beginner",
		progress: 20,
		color: "#7F52FF",
	},
	{
		id: "c",
		name: "C",
		description: "面向底层系统、嵌入式环境与高性能场景的编程语言。",
		icon: "logos:c",
		category: "backend",
		level: "intermediate",
		progress: 60,
		color: "#A8B9CC",
	},
	{
		id: "cpp",
		name: "C++",
		description: "高性能系统编程语言，广泛用于游戏、桌面软件和引擎开发。",
		icon: "logos:c-plusplus",
		category: "backend",
		level: "beginner",
		progress: 33,
		color: "#00599C",
	},
	{
		id: "photoshop",
		name: "Photoshop",
		description: "用于图像编辑、视觉设计与素材处理的专业工具。",
		icon: "logos:adobe-photoshop",
		category: "tools",
		level: "intermediate",
		progress: 70,
		color: "#31A8FF",
	},
	{
		id: "blender",
		name: "Blender",
		description: "用于三维建模、材质、动画与插件工作流的开源创作工具。",
		icon: "logos:blender",
		category: "tools",
		level: "advanced",
		progress: 85,
		color: "#E87D0D",
	},
];
