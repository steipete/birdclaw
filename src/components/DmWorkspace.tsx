import { formatCompactNumber, formatShortTimestamp } from "#/lib/present";
import type { DmConversationItem, DmMessageItem } from "#/lib/types";
import {
	actionButtonClass,
	composerBarClass,
	composerInputClass,
	composerShellClass,
	contextBioClass,
	contextHandleClass,
	contextStatRowClass,
	contextStatsClass,
	contextStatTermClass,
	contextStatValueClass,
	cx,
	dmGridClass,
	dmListClass,
	dmListCopyClass,
	dmListItemActiveClass,
	dmListItemClass,
	dmPreviewTextClass,
	emptyStateClass,
	eyebrowClass,
	identityRowClass,
	messageBubbleClass,
	messageBubbleOutboundClass,
	messageMetaClass,
	messageRowClass,
	messageRowOutboundClass,
	messageStackClass,
	metaStackClass,
	pillAlertClass,
	pillClass,
	pillSoftClass,
	threadBioClass,
	threadDetailColumnClass,
	threadDetailHeaderClass,
	threadHeaderClass,
	threadShellClass,
	threadSubtitleClass,
	threadTitleClass,
	timestampClass,
} from "#/lib/ui";
import { AvatarChip } from "./AvatarChip";

function MessageBubble({ message }: { message: DmMessageItem }) {
	return (
		<div
			className={cx(
				messageRowClass,
				message.direction === "outbound" && messageRowOutboundClass,
			)}
		>
			<div className={messageMetaClass}>
				<span>{message.sender.displayName}</span>
				<span>{formatShortTimestamp(message.createdAt)}</span>
			</div>
			<div
				className={cx(
					messageBubbleClass,
					message.direction === "outbound" && messageBubbleOutboundClass,
				)}
			>
				{message.text}
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
		? `${selectedConversation.needsReply ? "Reply owed" : "Thread clear"} · last message ${formatShortTimestamp(selectedConversation.lastMessageAt)}`
		: "No conversation selected";

	return (
		<section className={dmGridClass}>
			<aside className={dmListClass}>
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
							<div className={dmListCopyClass}>
								<div className={identityRowClass}>
									<strong>{conversation.participant.displayName}</strong>
									<span>@{conversation.participant.handle}</span>
								</div>
								<p className={dmPreviewTextClass}>
									{conversation.lastMessagePreview}
								</p>
							</div>
							<div className={metaStackClass}>
								<span
									className={cx(
										pillClass,
										conversation.needsReply ? pillAlertClass : pillSoftClass,
									)}
								>
									{conversation.needsReply ? "needs reply" : "clear"}
								</span>
								<span className={cx(pillClass, pillSoftClass)}>
									{conversation.influenceScore} · {conversation.influenceLabel}
								</span>
								<span className={timestampClass}>
									{formatShortTimestamp(conversation.lastMessageAt)}
								</span>
							</div>
						</button>
					);
				})}
			</aside>

			<div className={threadShellClass}>
				{selectedConversation ? (
					<>
						<header className={threadHeaderClass}>
							<div>
								<p className={eyebrowClass}>direct messages</p>
								<h2 className={threadTitleClass}>
									{selectedConversation.participant.displayName}
								</h2>
								<p className={threadSubtitleClass}>{subtitle}</p>
								<p className={threadBioClass}>
									{selectedConversation.lastMessagePreview}
								</p>
							</div>
							<div className={threadDetailColumnClass}>
								<div className={threadDetailHeaderClass}>
									<AvatarChip
										avatarUrl={participant?.avatarUrl}
										hue={participant?.avatarHue ?? 18}
										name={participant?.displayName ?? "Unknown"}
										profileId={participant?.id ?? undefined}
										size="large"
									/>
									<div>
										<strong>{participant?.displayName}</strong>
										<p className={cx("context-handle", contextHandleClass)}>
											@{participant?.handle}
										</p>
									</div>
								</div>
								<p className={cx("context-bio", contextBioClass)}>
									{participant?.bio}
								</p>
								<dl className={contextStatsClass}>
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
											{selectedConversation.needsReply
												? "Needs reply"
												: "Replied"}
										</dd>
									</div>
									<div className={contextStatRowClass}>
										<dt className={contextStatTermClass}>Account</dt>
										<dd className={contextStatValueClass}>
											{selectedConversation.accountHandle}
										</dd>
									</div>
								</dl>
								<button
									className={actionButtonClass}
									onClick={() => onReplySend(selectedConversation.id)}
									type="button"
								>
									Reply
								</button>
							</div>
						</header>
						<div className={messageStackClass}>
							{selectedMessages.map((message) => (
								<MessageBubble key={message.id} message={message} />
							))}
						</div>
						<div className={composerShellClass}>
							<textarea
								className={composerInputClass}
								onChange={(event) => onReplyDraftChange(event.target.value)}
								placeholder={`Reply to @${selectedConversation.participant.handle}`}
								rows={4}
								value={replyDraft}
							/>
							<div className={composerBarClass}>
								<span className={timestampClass}>
									{selectedConversation.needsReply
										? "Reply still owed"
										: "Thread clear"}
								</span>
								<button
									className={actionButtonClass}
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
					<div className={emptyStateClass}>No DM selected.</div>
				)}
			</div>
		</section>
	);
}
