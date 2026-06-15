import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
		tsconfigPaths: true,
	},
	server: {
		allowedHosts: ["clawmac.sheep-coho.ts.net", ...extraAllowedHosts],
	},
});

export default config;
