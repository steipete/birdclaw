import { Link, useRouterState } from "@tanstack/react-router";
import {
	Bell,
	Bookmark,
	CalendarDays,
	Heart,
	Home,
	Inbox,
	Link as LinkIcon,
	Mail,
	ShieldOff,
} from "lucide-react";
import {
	cx,
	navLinkActiveClass,
	navLinkClass,
	navLinkIconClass,
	navLinkLabelClass,
	sidebarBrandClass,
	sidebarBrandCopyClass,
	sidebarBrandMarkClass,
	sidebarBrandTaglineClass,
	sidebarBrandTitleClass,
	sidebarFooterClass,
	sidebarNavClass,
	sidebarShellClass,
} from "#/lib/ui";
import { BirdclawMark } from "./BrandMark";
import { ThemeSlider } from "./ThemeSlider";

const links = [
	{ to: "/inbox", label: "Inbox", icon: Inbox },
	{ to: "/today", label: "Today", icon: CalendarDays },
	{ to: "/", label: "Home", icon: Home },
	{ to: "/mentions", label: "Mentions", icon: Bell },
	{ to: "/likes", label: "Likes", icon: Heart },
	{ to: "/bookmarks", label: "Bookmarks", icon: Bookmark },
	{ to: "/links", label: "Links", icon: LinkIcon },
	{ to: "/dms", label: "DMs", icon: Mail },
	{ to: "/blocks", label: "Blocks", icon: ShieldOff },
] as const;

export function AppNav() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return (
		<aside className={sidebarShellClass}>
			<div className="flex flex-col">
				<Link to="/" className={sidebarBrandClass}>
					<span className={sidebarBrandMarkClass}>
						<BirdclawMark className="size-10" />
					</span>
					<span className={sidebarBrandCopyClass}>
						<span className={sidebarBrandTitleClass}>birdclaw</span>
						<span className={sidebarBrandTaglineClass}>
							Fast search for your Twitter archive.
						</span>
					</span>
				</Link>
				<nav className={sidebarNavClass} aria-label="Primary">
					{links.map((link) => {
						const active = pathname === link.to;
						const Icon = link.icon;
						return (
							<Link
								key={link.to}
								to={link.to}
								aria-label={link.label}
								className={cx(navLinkClass, active && navLinkActiveClass)}
							>
								<Icon
									className={navLinkIconClass}
									size={22}
									strokeWidth={active ? 2.4 : 1.8}
									aria-hidden="true"
								/>
								<span className={navLinkLabelClass}>{link.label}</span>
							</Link>
						);
					})}
				</nav>
			</div>
			<div className={sidebarFooterClass}>
				<ThemeSlider />
			</div>
		</aside>
	);
}
