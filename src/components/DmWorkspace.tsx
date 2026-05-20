import { CheckCircle2, Circle } from "lucide-react";
import { formatCompactNumber, formatShortTimestamp } from "#/lib/present";
import type { DmConversationItem, DmMessageItem } from "#/lib/types";
import {
	composerBarClass,
	composerInputClass,
	contextStatRowClass,
	contextStatTermClass,
	contextStatValueClass,
	cx,
	dmComposerShellClass,
	dmListBodyClass,
	dmListClass,
	dmListHandleClass,
	dmListHeaderClass,
	dmListItemActiveClass,
	dmListItemClass,
	dmListNameClass,
	dmListPreviewClass,
	dmListTimestampClass,
	dmMessageBubbleClass,
	dmMessageBubbleOutboundClass,
	dmMessageMetaClass,
	dmMessageRowClass,
	dmMessageRowOutboundClass,
	dmMessagesClass,
	dmShellClass,
	dmThreadClass,
	dmThreadHeaderClass,
	dmThreadNameClass,
	dmThreadSubtitleClass,
	dmThreadTitleClass,
	pillAlertClass,
	pillClass,
	pillSoftClass,
	primaryButtonClass,
	timestampClass,
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";
import { BirdclawEmpty } from "./BrandMark";

function MessageBubble({ message }: { message: DmMessageItem }) {
	const outbound = message.direction === "outbound";
	return (
		<div
			className={cx(dmMessageRowClass, outbound && dmMessageRowOutboundClass)}
		>
			<div
				className={cx(
					dmMessageBubbleClass,
					outbound && dmMessageBubbleOutboundClass,
				)}
			>
				{message.text}
			</div>
			<div className={dmMessageMetaClass}>
				<span>{message.sender.displayName}</span>
				<span>·</span>
				<span>{formatShortTimestamp(message.createdAt)}</span>
			</div>
		</div>
	);
}

export function DmWorkspace({
	conversations,
	selectedConversation,
	selectedMessages,
	onSelectConversation,
	replyDraft,
	onReplyDraftChange,
	onReplySend,
}: {
	conversations: DmConversationItem[];
	selectedConversation: DmConversationItem | null;
	selectedMessages: DmMessageItem[];
	onSelectConversation: (conversationId: string) => void;
	replyDraft: string;
	onReplyDraftChange: (value: string) => void;
	onReplySend: (conversationId: string) => void;
}) {
	const participant = selectedConversation?.participant ?? null;
	const subtitle = selectedConversation
		? `${selectedConversation.isMessageRequest ? "Message request" : selectedConversation.needsReply ? "Reply open" : "We replied"} · last message ${formatShortTimestamp(selectedConversation.lastMessageAt)}`
		: "No conversation selected";

	return (
		<section className={dmShellClass}>
			<aside className={dmListClass}>
				{conversations.length === 0 ? (
					<BirdclawEmpty
						detail="Sync DMs to populate this lane."
						label="No conversations"
					/>
				) : null}
				{conversations.map((conversation) => {
					const active = conversation.id === selectedConversation?.id;
					return (
						<button
							key={conversation.id}
							className={cx(dmListItemClass, active && dmListItemActiveClass)}
							onClick={() => onSelectConversation(conversation.id)}
							type="button"
						>
							<AvatarChip
								avatarUrl={conversation.participant.avatarUrl}
								hue={conversation.participant.avatarHue}
								name={conversation.participant.displayName}
								profileId={conversation.participant.id}
							/>
							<div className={dmListBodyClass}>
								<div className={dmListHeaderClass}>
									<div className="flex min-w-0 items-center gap-1.5">
										<span className={dmListNameClass}>
											{conversation.participant.displayName}
										</span>
										<span className={dmListHandleClass}>
											@{conversation.participant.handle}
										</span>
									</div>
									<span className={dmListTimestampClass}>
										{formatShortTimestamp(conversation.lastMessageAt)}
									</span>
								</div>
								<p className={dmListPreviewClass}>
									{conversation.lastMessagePreview}
								</p>
								<div className="mt-1 flex items-center gap-1.5">
									<span
										className={cx(
											pillClass,
											conversation.needsReply ? pillAlertClass : pillSoftClass,
										)}
										aria-label={
											conversation.needsReply ? "Reply open" : "We replied"
										}
									>
										{conversation.needsReply ? (
											<Circle className="size-3" strokeWidth={2.2} />
										) : (
											<CheckCircle2 className="size-3.5" strokeWidth={2} />
										)}
										{conversation.needsReply ? "open" : "replied"}
									</span>
									{conversation.isMessageRequest ? (
										<span className={cx(pillClass, pillAlertClass)}>
											request
										</span>
									) : null}
									<span className={cx(pillClass, pillSoftClass)}>
										{formatCompactNumber(
											conversation.participant.followersCount,
										)}{" "}
										followers
									</span>
								</div>
							</div>
						</button>
					);
				})}
			</aside>

			<div className={dmThreadClass}>
				{selectedConversation ? (
					<>
						<header className={dmThreadHeaderClass}>
							<div className={dmThreadTitleClass}>
								<AvatarChip
									avatarUrl={participant?.avatarUrl}
									hue={participant?.avatarHue ?? 18}
									name={participant?.displayName ?? "Unknown"}
									profileId={participant?.id ?? undefined}
								/>
								<div className="min-w-0">
									<div className={dmThreadNameClass}>
										{selectedConversation.participant.displayName}
									</div>
									<div className={dmThreadSubtitleClass}>{subtitle}</div>
								</div>
							</div>
							<button
								className={primaryButtonClass}
								onClick={() => onReplySend(selectedConversation.id)}
								type="button"
							>
								Reply
							</button>
						</header>
						{participant?.bio || participant?.followersCount ? (
							<div className="border-b border-[var(--line)] px-4 py-3">
								{participant?.bio ? (
									<p className="text-[14px] leading-[1.4] text-[var(--ink)]">
										{participant.bio}
									</p>
								) : null}
								<dl className="mt-2 grid grid-cols-2 gap-1 text-[13px]">
									<div className={contextStatRowClass}>
										<dt className={contextStatTermClass}>Followers</dt>
										<dd className={contextStatValueClass}>
											{formatCompactNumber(participant?.followersCount ?? 0)}
										</dd>
									</div>
									<div className={contextStatRowClass}>
										<dt className={contextStatTermClass}>Influence</dt>
										<dd className={contextStatValueClass}>
											{selectedConversation.influenceScore} ·{" "}
											{selectedConversation.influenceLabel}
										</dd>
									</div>
									<div className={contextStatRowClass}>
										<dt className={contextStatTermClass}>Reply state</dt>
										<dd className={contextStatValueClass}>
											{selectedConversation.isMessageRequest
												? "Message request"
												: selectedConversation.needsReply
													? "Reply open"
													: "We replied"}
										</dd>
									</div>
									<div className={contextStatRowClass}>
										<dt className={contextStatTermClass}>Account</dt>
										<dd className={contextStatValueClass}>
											{selectedConversation.accountHandle}
										</dd>
									</div>
								</dl>
							</div>
						) : null}
						<div className={dmMessagesClass}>
							{selectedMessages.map((message) => (
								<MessageBubble key={message.id} message={message} />
							))}
						</div>
						<div className={dmComposerShellClass}>
							<textarea
								className={composerInputClass}
								onChange={(event) => onReplyDraftChange(event.target.value)}
								placeholder={`Reply to @${selectedConversation.participant.handle}`}
								rows={3}
								value={replyDraft}
							/>
							<div className={composerBarClass}>
								<span className={timestampClass}>
									{selectedConversation.needsReply
										? "Reply open"
										: "We replied"}
								</span>
								<button
									className={primaryButtonClass}
									disabled={!replyDraft.trim()}
									onClick={() => onReplySend(selectedConversation.id)}
									type="button"
								>
									Send reply
								</button>
							</div>
						</div>
					</>
				) : (
					<BirdclawEmpty
						detail="Pick a conversation to read the thread."
						label="No DM selected"
					/>
				)}
			</div>
		</section>
	);
}
