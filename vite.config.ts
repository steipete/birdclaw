import { fileURLToPath } from "node:url";
import { prepareBrandAsset } from "./scripts/brand-asset.ts";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const brandAsset = await prepareBrandAsset(
	fileURLToPath(new URL(".", import.meta.url)),
);

const extraAllowedHosts =
	process.env.BIRDCLAW_ALLOWED_HOSTS?.split(",")
		.map((host) => host.trim())
		.filter(Boolean) ?? [];

const config = defineConfig({
	plugins: [
		tailwindcss(),
		tanstackStart({
			router: {
				routeFileIgnorePattern: "\\.(test|spec)\\.(ts|tsx)$",
			},
		}),
		viteReact(),
	],
	resolve: {
		alias: { "virtual:birdclaw-brand?url": `${brandAsset}?url` },
		tsconfigPaths: true,
	},
	ssr: {
		noExternal: ["h3-v2", "rou3", "srvx"],
	},
	server: {
		allowedHosts: ["clawmac.sheep-coho.ts.net", ...extraAllowedHosts],
	},
});

export default config;
