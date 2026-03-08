import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		to,
		className,
	}: {
		children: ReactNode;
		to: string;
		className: string;
	}) => (
		<a className={className} href={to}>
			{children}
		</a>
	),
	useRouterState: ({
		select,
	}: {
		select: (state: { location: { pathname: string } }) => string;
	}) => select({ location: { pathname: "/inbox" } }),
}));

import { AppNav } from "./AppNav";

describe("AppNav", () => {
	it("marks the active route", () => {
		render(<AppNav />);

		expect(screen.getByRole("link", { name: "Inbox" })).toHaveClass(
			"nav-link-active",
		);
		expect(screen.getByRole("link", { name: "Blocks" })).toBeInTheDocument();
		expect(screen.getByText("Quiet signal for X.")).toBeInTheDocument();
	});
});
