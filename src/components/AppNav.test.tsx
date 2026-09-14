import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "#/lib/theme";
import { renderWithQueryClient as render } from "#/test/render";

const routerState = vi.hoisted(() => ({ path: "/inbox" }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({
		children,
		to,
		className,
		...props
	}: {
		children: ReactNode;
		to: string;
		className: string;
		[key: string]: unknown;
	}) => (
		<a className={className} href={to} {...props}>
			{children}
		</a>
	),
	useRouterState: ({
		select,
	}: {
		select: (state: { location: { pathname: string } }) => string;
	}) => select({ location: { pathname: routerState.path } }),
}));

vi.mock("./AccountSwitcher", () => ({
	AccountSwitcher: ({ action }: { action?: ReactNode }) => (
		<div data-testid="account-switcher">{action}</div>
	),
}));

import { AppNav } from "./AppNav";

afterEach(() => {
	routerState.path = "/inbox";
	cleanup();
});

describe("AppNav", () => {
	it("keeps cached archive navigation and hides live-only pages in read-only mode", () => {
		render(
			<ThemeProvider>
				<AppNav />
			</ThemeProvider>,
			{ readOnly: true },
		);
		expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "DMs" })).toBeInTheDocument();
		for (const name of [
			"Today",
			"Discuss",
			"Analyse",
			"Sources",
			"Rate Limits",
		])
			expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
		expect(screen.getByText("Read-only archive")).toBeInTheDocument();
	});
	it("marks the active route", () => {
		render(
			<ThemeProvider>
				<AppNav />
			</ThemeProvider>,
		);

		expect(screen.getByRole("link", { name: "Inbox" })).toHaveClass(
			"nav-link-active",
		);
		expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute(
			"aria-label",
			"Inbox",
		);
		expect(screen.getByRole("link", { name: "Blocks" })).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Rate Limits" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Fast search for your archive."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Theme: System default. Switch to Light theme.",
			}),
		).toBeInTheDocument();
	});

	it("places the theme toggle inside the bottom account picker", () => {
		render(
			<ThemeProvider>
				<AppNav />
			</ThemeProvider>,
		);

		const themeButton = screen.getByRole("button", {
			name: "Theme: System default. Switch to Light theme.",
		});
		const accountSwitcher = screen.getByTestId("account-switcher");

		expect(accountSwitcher).toContainElement(themeButton);
	});

	it("only visually hides standard labels below the wide-sidebar breakpoint", () => {
		render(
			<ThemeProvider>
				<AppNav />
			</ThemeProvider>,
		);

		const inboxLabel = screen.getByText("Inbox");
		expect(inboxLabel).toHaveClass("max-[1100px]:sr-only");
		expect(inboxLabel).not.toHaveClass("sr-only");
		expect(inboxLabel).not.toHaveClass("min-[1100px]:not-sr-only");
	});

	it("uses icon-rail chrome when compact", () => {
		routerState.path = "/dms";
		render(
			<ThemeProvider>
				<AppNav compact />
			</ThemeProvider>,
		);

		expect(screen.getByRole("link", { name: "DMs" })).toHaveClass(
			"nav-link-active",
		);
		expect(screen.getByRole("link", { name: "DMs" })).toHaveClass(
			"justify-center",
		);
		expect(screen.getByText("birdclaw").parentElement).toHaveClass("sr-only");
		expect(screen.getByText("DMs")).toHaveClass("sr-only");
	});
});
