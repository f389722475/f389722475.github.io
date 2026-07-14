// 设备数据配置文件

export interface Device {
	name: string;
	image: string;
	specs: string;
	description: string;
	link: string;
}

// 设备类别类型，支持品牌和自定义类别
export type DeviceCategory = Record<string, Device[]> & {
	自定义?: Device[];
};

export const devicesData: DeviceCategory = {
	OnePlus: [
		{
			name: "OnePlus 13T",
			image: "/images/device/oneplus13t.webp",
			specs: "灰色 / 16G + 1TB",
			description: "旗舰性能，哈苏影像，80W SuperVOOC。",
			link: "https://www.oneplus.com/cn/13t",
		},
	],
	路由器: [
		{
			name: "GL-MT3000",
			image: "/images/device/mt3000.webp",
			specs: "1000Mbps / 2.5G",
			description: "便携式 WiFi 6 路由器，适合出差和家庭使用。",
			link: "https://www.gl-inet.cn/products/gl-mt3000/",
		},
	],
};
