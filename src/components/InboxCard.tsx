import { Link } from "@tanstack/react-router";
import { ExternalLink, MessageCircle } from "lucide-react";
import { formatCompactNumber, formatShortTimestamp } from "#/lib/present";
import type { InboxItem } from "#/lib/types";
import {
	composerBarClass,
	composerInputClass,
	composerShellClass,
	cx,
	feedRowBodyClass,
	feedRowClass,
	feedRowDotClass,
	feedRowHandleClass,
	feedRowHeaderClass,
	feedRowNameClass,
	feedRowTextClass,
	feedRowTimestampClass,
	inboxAnalysisClass,
	mutedDotClass,
	pillAlertClass,
	pillClass,
	pillSoftClass,
	primaryButtonClass,
	secondaryButtonClass,
	timestampClass,
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";

export function InboxCard({
	item,
	isReplying,
	replyDraft,
	onReplyChange,
	onReplyToggle,
	onReplySend,
}: {
	item: InboxItem;
	isReplying: boolean;
	replyDraft: string;
	onReplyChange: (value: string) => void;
	onReplyToggle: () => void;
	onReplySend: () => void;
}) {
	return (
		<article className={cx(feedRowClass, "items-start")}>
			<AvatarChip
				avatarUrl={item.participant.avatarUrl}
				hue={item.participant.avatarHue}
				name={item.participant.displayName}
				profileId={item.participant.id}
			/>
			<div className={feedRowBodyClass}>
				<header className={feedRowHeaderClass}>
					<span className="flex min-w-0 items-center gap-1.5">
						<span className={feedRowNameClass}>
							{item.participant.displayName}
						</span>
						<span className={feedRowHandleClass}>
							@{item.participant.handle}
						</span>
					</span>
					<span className={feedRowDotClass}>·</span>
					<span className={feedRowTimestampClass}>
						{formatShortTimestamp(item.createdAt)}
					</span>
					<span className="ml-auto flex items-center gap-1.5">
						<span className={cx(pillClass, pillSoftClass)}>
							{item.entityKind}
						</span>
						<span className={cx(pillClass, pillAlertClass)}>
							score {item.score}
						</span>
					</span>
				</header>
				<h3 className="text-[15px] font-bold text-[var(--ink)]">
					{item.title}
				</h3>
				<p className={feedRowTextClass}>{item.text}</p>
				<div className={inboxAnalysisClass}>
					<strong className="text-[var(--ink)]">{item.summary}</strong>
					<p>{item.reasoning}</p>
				</div>
				<div className="mt-2 flex items-center justify-between gap-3 text-[13px] text-[var(--ink-soft)]">
					<div className="flex flex-wrap items-center gap-2">
						<span>{item.source}</span>
						<span className={mutedDotClass} />
						<span>influence {formatCompactNumber(item.influenceScore)}</span>
						<span className={mutedDotClass} />
						<span>{item.needsReply ? "needs reply" : "resolved"}</span>
					</div>
					<div className="flex items-center gap-2">
						<button
							className={secondaryButtonClass}
							onClick={onReplyToggle}
							type="button"
						>
							<MessageCircle className="size-4" strokeWidth={2} />
							{isReplying ? "Close reply" : "Reply"}
						</button>
						<Link
							className={cx(secondaryButtonClass, "gap-1.5")}
							to={item.entityKind === "dm" ? "/dms" : "/mentions"}
						>
							<ExternalLink className="size-4" strokeWidth={2} />
							Open
						</Link>
					</div>
				</div>
				{isReplying ? (
					<div className={composerShellClass}>
						<textarea
							className={composerInputClass}
							onChange={(event) => onReplyChange(event.target.value)}
							placeholder={
								item.entityKind === "dm"
									? `Reply to @${item.participant.handle}`
									: `Reply to mention from @${item.participant.handle}`
							}
							rows={4}
							value={replyDraft}
						/>
						<div className={composerBarClass}>
							<span className={timestampClass}>Send from inbox</span>
							<button
								className={primaryButtonClass}
								disabled={!replyDraft.trim()}
								onClick={onReplySend}
								type="button"
							>
								Send
							</button>
						</div>
					</div>
				) : null}
			</div>
		</article>
	);
}
