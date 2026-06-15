import {
	createRootRoute,
	HeadContent,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppNav } from "#/components/AppNav";
import { ThemeProvider, themeScript } from "#/lib/theme";
import {
	bodyClass,
	mainColumnClass,
	mainColumnDmClass,
	siteShellClass,
	siteShellDmClass,
} from "#/lib/ui";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "birdclaw",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	notFoundComponent: NotFoundView,
	shellComponent: RootDocument,
});

function NotFoundView() {
	return (
		<main className={mainColumnClass}>
			<div className="px-4 py-10 text-[var(--ink-soft)]">Not Found</div>
		</main>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const wideMode =
		pathname.startsWith("/dms") || pathname.startsWith("/network-map");

	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
				<script suppressHydrationWarning>{themeScript}</script>
			</head>
			<body className={bodyClass}>
				<ThemeProvider>
					<div className={wideMode ? siteShellDmClass : siteShellClass}>
						<AppNav compact={wideMode} />
						<main className={wideMode ? mainColumnDmClass : mainColumnClass}>
							{children}
						</main>
					</div>
				</ThemeProvider>
				<Scripts />
			</body>
		</html>
	);
}
