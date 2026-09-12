import brandMarkUrl from "virtual:birdclaw-brand?url";
import { cx, emptyStateClass } from "#/lib/ui";

export function BirdclawMark({
	animated = false,
	className,
}: {
	animated?: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cx(
				"birdclaw-mark relative inline-grid shrink-0 place-items-center",
				animated && "birdclaw-mark-animated",
				className,
			)}
		>
			<img
				alt=""
				className="size-full object-contain drop-shadow-[0_10px_22px_var(--brand-shadow)]"
				draggable={false}
				src={brandMarkUrl}
			/>
		</span>
	);
}

export function BirdclawLoading({
	label,
	detail,
}: {
	label: string;
	detail?: string;
}) {
	return (
		<div className={cx(emptyStateClass, "birdclaw-state")}>
			<BirdclawMark animated className="size-16" />
			<div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">
				{label}
			</div>
			{detail ? (
				<div className="mt-1 text-[13px] text-[var(--ink-soft)]">{detail}</div>
			) : null}
		</div>
	);
}

export function BirdclawEmpty({
	label,
	detail,
}: {
	label: string;
	detail?: string;
}) {
	return (
		<div className={cx(emptyStateClass, "birdclaw-state")}>
			<BirdclawMark className="size-12 opacity-75" />
			<div className="mt-3 text-[14px] font-semibold text-[var(--ink)]">
				{label}
			</div>
			{detail ? (
				<div className="mt-1 text-[13px] text-[var(--ink-soft)]">{detail}</div>
			) : null}
		</div>
	);
}
