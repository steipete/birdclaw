import {
	createRootRoute,
	HeadContent,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppNav } from "#/components/AppNav";
import { READ_ONLY_ARCHIVE_PAGES } from "#/lib/api-enums";
import {
	DeploymentModeProvider,
	useDeploymentMode,
} from "#/lib/deployment-mode";
import { BirdclawQueryProvider } from "#/lib/query-client";
import { ThemeProvider, themeScript } from "#/lib/theme";
import {
	bodyClass,
	mainColumnClass,
	mainColumnDmClass,
	siteShellClass,
} from "#/lib/ui";

import appCss from "../styles.css?url";
import brandMarkUrl from "virtual:birdclaw-brand?url";

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
			{ rel: "icon", type: "image/png", href: brandMarkUrl },
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
				<BirdclawQueryProvider>
					<ThemeProvider>
						<DeploymentModeProvider>
							<div className={siteShellClass}>
								<AppNav compact={wideMode} />
								<main
									className={wideMode ? mainColumnDmClass : mainColumnClass}
								>
									<ArchivePage pathname={pathname}>{children}</ArchivePage>
								</main>
							</div>
						</DeploymentModeProvider>
					</ThemeProvider>
				</BirdclawQueryProvider>
				<Scripts />
			</body>
		</html>
	);
}

function ArchivePage({
	pathname,
	children,
}: {
	pathname: string;
	children: ReactNode;
}) {
	const { readOnly } = useDeploymentMode();
	if (readOnly && !READ_ONLY_ARCHIVE_PAGES.includes(pathname)) {
		return (
			<p className="p-6">
				This page is unavailable in a read-only archive deployment.{" "}
				<a href="/">Browse the archive.</a>
			</p>
		);
	}
	return children;
}
