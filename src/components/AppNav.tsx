import { Link, useRouterState } from "@tanstack/react-router";

const links = [
	{ to: "/inbox", label: "Inbox" },
	{ to: "/", label: "Home" },
	{ to: "/mentions", label: "Mentions" },
	{ to: "/dms", label: "DMs" },
	{ to: "/blocks", label: "Blocks" },
] as const;

export function AppNav() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return (
		<nav className="app-nav">
			<div>
				<p className="eyebrow">birdclaw</p>
				<h1 className="brand-mark">Quiet signal for X.</h1>
			</div>
			<div className="nav-links">
				{links.map((link) => {
					const active = pathname === link.to;
					return (
						<Link
							key={link.to}
							to={link.to}
							className={active ? "nav-link nav-link-active" : "nav-link"}
						>
							{link.label}
						</Link>
					);
				})}
			</div>
		</nav>
	);
}
