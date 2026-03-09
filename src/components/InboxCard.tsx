import { Link } from "@tanstack/react-router";
import { formatCompactNumber, formatShortTimestamp } from "#/lib/present";
import type { InboxItem } from "#/lib/types";
import {
	actionButtonClass,
	actionRowClass,
	bodyCopyClass,
	cardFooterClass,
	cardHeaderClass,
	composerBarClass,
	composerInputClass,
	composerShellClass,
	contentCardClass,
	cx,
	eyebrowClass,
	identityBlockClass,
	identityRowClass,
	inboxAnalysisClass,
	inboxTitleClass,
	metaStackClass,
	metricRowClass,
	mutedDotClass,
	navLinkClass,
	pillAlertClass,
	pillClass,
	pillSoftClass,
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
		<article className={cx(contentCardClass, "inbox-card")}>
			<div className={cardHeaderClass}>
				<div className={identityBlockClass}>
					<AvatarChip
						avatarUrl={item.participant.avatarUrl}
						hue={item.participant.avatarHue}
						name={item.participant.displayName}
						profileId={item.participant.id}
					/>
					<div>
						<div className={identityRowClass}>
							<strong>{item.participant.displayName}</strong>
							<span>@{item.participant.handle}</span>
							<span className={mutedDotClass} />
							<span>
								{formatCompactNumber(item.participant.followersCount)} followers
							</span>
						</div>
					</div>
				</div>
				<div className={metaStackClass}>
					<span className={cx(pillClass, pillSoftClass)}>
						{item.entityKind}
					</span>
					<span className={cx(pillClass, pillAlertClass)}>
						score {item.score}
					</span>
					<span className={timestampClass}>
						{formatShortTimestamp(item.createdAt)}
					</span>
				</div>
			</div>
			<p className={eyebrowClass}>ai triage</p>
			<h3 className={inboxTitleClass}>{item.title}</h3>
			<p className={bodyCopyClass}>{item.text}</p>
			<div className={inboxAnalysisClass}>
				<strong>{item.summary}</strong>
				<p>{item.reasoning}</p>
			</div>
			<div className={cardFooterClass}>
				<div className={metricRowClass}>
					<span>{item.source}</span>
					<span>influence {item.influenceScore}</span>
					<span>{item.needsReply ? "needs reply" : "resolved"}</span>
				</div>
				<div className={actionRowClass}>
					<button
						className={navLinkClass}
						onClick={onReplyToggle}
						type="button"
					>
						{isReplying ? "Close reply" : "Reply"}
					</button>
					<Link
						className={actionButtonClass}
						to={item.entityKind === "dm" ? "/dms" : "/mentions"}
					>
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
							className={actionButtonClass}
							disabled={!replyDraft.trim()}
							onClick={onReplySend}
							type="button"
						>
							Send
						</button>
					</div>
				</div>
			) : null}
		</article>
	);
}
