import type { ReactNode } from "react";
import { BirdclawEmpty, BirdclawLoading } from "./BrandMark";

function SkeletonBlock({
	className,
	muted = false,
}: {
	className: string;
	muted?: boolean;
}) {
	return (
		<span
			aria-hidden="true"
			className={`block animate-pulse rounded-full ${muted ? "bg-[color:color-mix(in_srgb,var(--ink-soft)_16%,transparent)]" : "bg-[color:color-mix(in_srgb,var(--ink-soft)_24%,transparent)]"} ${className}`}
		/>
	);
}

export function TweetSkeletonRows({ count = 4 }: { count?: number }) {
	return (
		<div aria-hidden="true" className="divide-y divide-[var(--line)]">
			{Array.from({ length: count }, (_unused, index) => {
				const hasMedia = index % 3 === 0;
				const hasQuote = index % 4 === 2;
				return (
					<article
						className="flex gap-3 px-4 py-3"
						data-perf="tweet-skeleton-row"
						key={`tweet-skeleton-${index}`}
					>
						<SkeletonBlock className="size-10 shrink-0 rounded-full" />
						<div className="min-w-0 flex-1 space-y-3">
							<div className="flex items-center gap-2">
								<SkeletonBlock className="h-3.5 w-32" />
								<SkeletonBlock className="h-3 w-20" muted />
								<SkeletonBlock className="ml-auto h-5 w-16" muted />
							</div>
							<div className="space-y-2">
								<SkeletonBlock className="h-3 w-full" />
								<SkeletonBlock className="h-3 w-11/12" muted />
								{index % 2 === 0 ? (
									<SkeletonBlock className="h-3 w-7/12" muted />
								) : null}
							</div>
							{hasMedia ? (
								<SkeletonBlock className="h-32 w-full rounded-2xl" muted />
							) : null}
							{hasQuote ? (
								<div className="space-y-2 rounded-2xl border border-[var(--line)] px-3 py-2">
									<SkeletonBlock className="h-3 w-28" muted />
									<SkeletonBlock className="h-3 w-full" muted />
								</div>
							) : null}
							<div className="flex max-w-md items-center justify-between">
								{["thread", "reply", "repost", "like"].map((key) => (
									<SkeletonBlock className="h-3 w-11" key={key} muted />
								))}
							</div>
						</div>
					</article>
				);
			})}
		</div>
	);
}

export function LinkSkeletonRows({ count = 4 }: { count?: number }) {
	return (
		<div aria-hidden="true" className="divide-y divide-[var(--line)]">
			{Array.from({ length: count }, (_unused, index) => (
				<article
					className="flex gap-3 px-4 py-3"
					data-perf="link-skeleton-row"
					key={`link-skeleton-${index}`}
				>
					<SkeletonBlock className="size-9 shrink-0 rounded-full" muted />
					<div className="min-w-0 flex-1 space-y-3">
						<SkeletonBlock className="h-3.5 w-8/12" />
						<SkeletonBlock className="h-3 w-6/12" muted />
						<div className="flex flex-wrap gap-2">
							<SkeletonBlock className="h-3 w-20" muted />
							<SkeletonBlock className="h-3 w-14" muted />
							<SkeletonBlock className="h-3 w-24" muted />
						</div>
						{index % 2 === 0 ? (
							<SkeletonBlock
								className="h-20 w-72 max-w-full rounded-2xl"
								muted
							/>
						) : null}
					</div>
				</article>
			))}
		</div>
	);
}

export function FeedLoading({
	children,
	detail,
	label,
}: {
	children?: ReactNode;
	detail?: string;
	label: string;
}) {
	return (
		<div className="border-b border-[var(--line)]">
			<BirdclawLoading detail={detail} label={label} />
			{children}
		</div>
	);
}

export function FeedError({
	action,
	message,
	title = "Could not load this view",
}: {
	action?: ReactNode;
	message: string;
	title?: string;
}) {
	return (
		<div className="border-b border-[var(--line)] px-6 py-10 text-center">
			<div className="mx-auto max-w-sm">
				<div className="text-[14px] font-bold text-[var(--alert)]">{title}</div>
				<p className="mt-2 text-[13px] leading-[1.45] text-[var(--ink-soft)]">
					{message}
				</p>
				{action ? (
					<div className="mt-4 flex justify-center">{action}</div>
				) : null}
			</div>
		</div>
	);
}

export function FeedEmpty({
	detail,
	label,
}: {
	detail?: string;
	label: string;
}) {
	return <BirdclawEmpty detail={detail} label={label} />;
}
