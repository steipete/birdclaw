export function cx(...values: Array<string | false | null | undefined>) {
	return values.filter(Boolean).join(" ");
}

export const bodyClass =
	"min-h-screen bg-[var(--bg)] font-sans text-[var(--ink)] antialiased text-[15px] leading-[1.4]";

/* App shell — sidebar left, single feed column center, optional aside right. */
export const siteShellClass =
	"mx-auto flex min-h-screen w-full max-w-[1280px] gap-0";

export const sidebarShellClass =
	"sticky top-0 z-30 flex h-screen w-[72px] shrink-0 flex-col justify-between border-r border-[var(--line)] bg-[var(--bg)] px-2 py-3 min-[1100px]:w-[260px] min-[1100px]:px-3";

export const sidebarBrandClass =
	"flex items-center gap-2.5 px-2 py-2 text-[var(--ink)] min-[1100px]:px-3";

export const sidebarBrandMarkClass =
	"grid size-9 place-items-center rounded-full bg-[var(--accent)] text-white";

export const sidebarBrandCopyClass =
	"hidden flex-col leading-tight min-[1100px]:flex";

export const sidebarBrandTitleClass = "text-[15px] font-bold tracking-tight";

export const sidebarBrandTaglineClass = "text-[12px] text-[var(--ink-soft)]";

export const sidebarNavClass = "mt-2 flex flex-col gap-0.5";

export const sidebarFooterClass = "flex flex-col gap-2 pb-1";

export const navLinkClass =
	"nav-link group flex items-center justify-center gap-4 rounded-full px-3 py-2.5 text-[15px] text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--bg-hover)] min-[1100px]:justify-start";

export const navLinkActiveClass = "nav-link-active font-bold";

export const navLinkIconClass = "shrink-0";

export const navLinkLabelClass = "sr-only min-[1100px]:not-sr-only";

/* Main column. */
export const mainColumnClass =
	"flex w-full min-w-0 max-w-[680px] flex-1 flex-col border-x border-[var(--line)] bg-[var(--bg)]";

export const pageWrapClass = "flex w-full min-w-0 flex-1 justify-start";

/* Sticky page header at top of the main column. */
export const pageHeaderClass =
	"sticky top-0 z-20 flex flex-col gap-0 border-b border-[var(--line)] bg-[color:color-mix(in_srgb,var(--bg)_85%,transparent)] backdrop-blur";

export const pageHeaderRowClass =
	"flex items-center justify-between gap-3 px-4 pt-3 pb-2";

export const pageTitleClass = "m-0 text-[20px] font-bold tracking-tight";

export const pageSubtitleClass = "text-[13px] text-[var(--ink-soft)]";

export const pageHeaderActionsClass = "flex items-center gap-2";

/* Sticky tab strip Twitter-style. */
export const tabStripClass =
	"flex w-full items-stretch border-b border-[var(--line)] overflow-x-auto";

export const tabButtonClass =
	"relative flex flex-1 min-w-[88px] items-center justify-center px-3 py-3.5 text-[14px] font-medium text-[var(--ink-soft)] transition-colors duration-150 hover:bg-[var(--bg-hover)]";

export const tabButtonActiveClass = "text-[var(--ink)] font-bold";

export const tabButtonIndicatorClass =
	"pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-[3px] w-12 rounded-full bg-[var(--accent)]";

/* Feed rows: flat, hairline divider, no boxed cards. */
export const feedClass = "flex flex-col";

export const feedRowClass =
	"flex w-full gap-3 border-b border-[var(--line)] px-4 py-3 transition-colors duration-150 hover:bg-[var(--bg-hover)]";

export const feedRowBodyClass = "flex min-w-0 flex-1 flex-col gap-1";

export const feedRowHeaderClass =
	"flex min-w-0 items-center gap-1.5 text-[15px]";

export const feedRowNameClass =
	"truncate font-bold text-[var(--ink)] hover:underline";

export const feedRowHandleClass = "truncate text-[var(--ink-soft)]";

export const feedRowDotClass = "text-[var(--ink-soft)]";

export const feedRowTimestampClass =
	"shrink-0 text-[var(--ink-soft)] hover:underline";

export const feedRowMetaClass =
	"flex flex-wrap items-center gap-2 text-[13px] text-[var(--ink-soft)]";

export const feedRowActionsClass =
	"mt-2 flex max-w-md items-center justify-between text-[var(--ink-soft)]";

export const feedActionButtonClass =
	"action-button group/action inline-flex items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-[13px] text-[var(--ink-soft)] transition-colors duration-150 hover:text-[var(--accent)] disabled:cursor-default disabled:opacity-55";

export const feedActionLikeClass = "hover:text-[var(--like)]";

export const feedActionIconWrapClass =
	"grid size-[34px] place-items-center rounded-full transition-colors duration-150 group-hover/action:bg-[var(--accent-soft)]";

export const feedActionIconWrapLikeClass =
	"group-hover/action:bg-[var(--like-soft)]";

export const feedActionIconClass = "size-[18px]";

export const feedRowTextClass =
	"whitespace-pre-wrap break-words text-[15px] leading-[1.45] text-[var(--ink)] [overflow-wrap:anywhere]";

export const feedRowBadgeClass =
	"inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[12px] font-semibold text-[var(--accent)]";

export const feedRowBadgeAlertClass =
	"bg-[var(--alert-soft)] text-[var(--alert)]";

export const feedRowBadgeNeutralClass =
	"bg-[var(--bg-active)] text-[var(--ink-soft)]";

/* Forms / inputs. */
export const searchFieldShellClass =
	"flex items-center gap-2 rounded-full border border-transparent bg-[var(--bg-active)] px-4 py-2 transition-colors focus-within:border-[var(--accent)] focus-within:bg-[var(--bg)] focus-within:shadow-[0_0_0_1px_var(--accent)]";

export const searchFieldIconClass =
	"size-[18px] text-[var(--ink-soft)] shrink-0";

export const searchFieldInputClass =
	"min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]";

export const textFieldClass =
	"w-full rounded-md border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-[14px] text-[var(--ink)] outline-none transition-colors duration-150 placeholder:text-[var(--ink-soft)] focus:border-[var(--accent)] focus:shadow-[0_0_0_1px_var(--accent)] disabled:cursor-default disabled:opacity-55";

export const textFieldWideClass = "w-full";

export const textFieldShortClass = "w-[120px]";

export const selectFieldClass = cx(textFieldClass, "appearance-none pr-8");

/* Buttons. */
export const primaryButtonClass =
	"inline-flex items-center justify-center gap-1.5 rounded-full border-0 bg-[var(--accent)] px-4 py-1.5 text-[14px] font-bold text-white shadow-none transition-colors duration-150 hover:bg-[var(--accent-hover)] active:bg-[var(--accent-press)] disabled:cursor-default disabled:opacity-55";

export const primaryButtonLargeClass =
	"inline-flex items-center justify-center gap-1.5 rounded-full border-0 bg-[var(--accent)] px-5 py-2.5 text-[15px] font-bold text-white shadow-none transition-colors duration-150 hover:bg-[var(--accent-hover)] active:bg-[var(--accent-press)] disabled:cursor-default disabled:opacity-55";

export const secondaryButtonClass =
	"inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--line-strong)] bg-transparent px-4 py-1.5 text-[14px] font-bold text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-55";

export const dangerButtonClass =
	"inline-flex items-center justify-center gap-1.5 rounded-full border border-[var(--alert)] bg-transparent px-4 py-1.5 text-[14px] font-bold text-[var(--alert)] transition-colors duration-150 hover:bg-[var(--alert-soft)] disabled:cursor-default disabled:opacity-55";

export const actionButtonClass = primaryButtonClass;

/* Legacy segmented control retained for routes that still use it (compact pill). */
export const segmentedClass =
	"inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg)] p-1";

export const segmentClass =
	"rounded-full border-0 bg-transparent px-3 py-1 text-[13px] font-medium text-[var(--ink-soft)] capitalize transition-colors duration-150";

export const segmentActiveClass = "bg-[var(--bg-active)] text-[var(--ink)]";

/* Composer (reply textarea). */
export const composerShellClass =
	"mt-2 flex flex-col gap-2 border-t border-[var(--line)] pt-3";

export const composerInputClass =
	"min-h-[88px] w-full resize-y rounded-md border border-[var(--line)] bg-[var(--bg)] px-3 py-2.5 text-[15px] text-[var(--ink)] outline-none transition-colors duration-150 placeholder:text-[var(--ink-soft)] focus:border-[var(--accent)] focus:shadow-[0_0_0_1px_var(--accent)]";

export const composerBarClass = "flex items-center justify-between gap-3";

/* Empty / loading. */
export const emptyStateClass = "px-6 py-10 text-center text-[var(--ink-soft)]";

export const errorCopyClass =
	"mx-4 my-3 whitespace-pre-wrap break-words rounded-md border border-[var(--alert)] bg-[var(--alert-soft)] px-3 py-2 text-[14px] text-[var(--alert)]";

export const statusCopyClass =
	"mx-4 my-3 rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3 py-2 text-[13px] text-[var(--ink-soft)]";

/* Avatars. */
export const avatarChipClass =
	"avatar-chip inline-grid size-10 shrink-0 place-items-center overflow-hidden rounded-full text-[14px] font-bold text-white";

export const avatarChipLargeClass = "avatar-chip-large size-16 text-[18px]";

export const avatarChipSmallClass = "avatar-chip-small size-8 text-[12px]";

/* Embedded tweet / link preview (rounded box, used inside feed row body). */
export const embeddedCardClass =
	"mt-2 overflow-hidden rounded-2xl border border-[var(--line)] transition-colors duration-150 hover:bg-[var(--bg-hover)]";

export const embeddedCardBodyClass = "flex flex-col gap-2 px-3 py-2.5";

export const embeddedCardHeaderClass = "flex items-center gap-1.5 text-[14px]";

export const embeddedCardNameClass = "font-bold text-[var(--ink)] truncate";

export const embeddedCardHandleClass = "text-[var(--ink-soft)] truncate";

export const embeddedCardLabelClass =
	"text-[12px] uppercase tracking-wide text-[var(--ink-soft)]";

export const embeddedCardCopyClass =
	"whitespace-pre-wrap text-[14px] leading-[1.4] text-[var(--ink)] [overflow-wrap:anywhere]";

export const linkPreviewCardClass =
	"group/link-preview mt-2 flex min-w-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg-card)] transition-colors duration-150 hover:bg-[var(--bg-hover)]";

export const linkPreviewTitleClass =
	"line-clamp-2 font-bold leading-tight text-[var(--ink)]";

export const linkPreviewDescClass =
	"line-clamp-2 text-[14px] leading-snug text-[var(--ink-soft)]";

export const linkPreviewHostClass =
	"text-[13px] text-[var(--ink-soft)] truncate";

/* DM grid. */
export const dmShellClass =
	"grid h-[calc(100vh-56px)] min-h-[520px] grid-cols-1 min-[1100px]:grid-cols-[320px_minmax(0,1fr)]";

export const dmListClass =
	"flex flex-col overflow-y-auto border-r border-[var(--line)]";

export const dmListItemClass =
	"flex w-full items-start gap-3 border-b border-[var(--line)] border-0 bg-transparent px-3 py-3 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)]";

export const dmListItemActiveClass = "bg-[var(--bg-active)]";

export const dmListBodyClass = "flex min-w-0 flex-1 flex-col gap-1";

export const dmListHeaderClass = "flex items-center justify-between gap-2";

export const dmListNameClass =
	"truncate text-[14px] font-bold text-[var(--ink)]";

export const dmListHandleClass = "truncate text-[13px] text-[var(--ink-soft)]";

export const dmListPreviewClass = "truncate text-[13px] text-[var(--ink-soft)]";

export const dmListTimestampClass =
	"shrink-0 text-[12px] text-[var(--ink-soft)]";

export const dmThreadClass = "flex min-w-0 flex-col";

export const dmThreadHeaderClass =
	"sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[color:color-mix(in_srgb,var(--bg)_85%,transparent)] px-4 py-3 backdrop-blur";

export const dmThreadTitleClass = "flex items-center gap-3 min-w-0";

export const dmThreadNameClass = "truncate text-[16px] font-bold";

export const dmThreadSubtitleClass =
	"truncate text-[13px] text-[var(--ink-soft)]";

export const dmMessagesClass =
	"flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-4";

export const dmMessageRowClass = "flex max-w-[78%] flex-col gap-1";

export const dmMessageRowOutboundClass = "self-end items-end";

export const dmMessageBubbleClass =
	"rounded-2xl rounded-bl-md bg-[var(--bg-active)] px-3.5 py-2 text-[15px] leading-[1.4] text-[var(--ink)]";

export const dmMessageBubbleOutboundClass =
	"rounded-bl-2xl rounded-br-md bg-[var(--accent)] text-white";

export const dmMessageMetaClass =
	"flex items-center gap-2 text-[12px] text-[var(--ink-soft)]";

export const dmComposerShellClass =
	"flex flex-col gap-2 border-t border-[var(--line)] px-4 py-3";

/* Profile hovercard. */
export const profilePreviewClass = "relative inline-flex";

export const profilePreviewTriggerClass =
	"profile-preview-trigger inline-flex text-inherit";

export const profilePreviewCardClass =
	"pointer-events-none absolute left-0 top-[calc(100%+8px)] z-30 grid w-[280px] translate-y-1 gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-3 opacity-0 shadow-[0_8px_28px_var(--shadow-strong)] transition-all duration-150 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100";

export const profilePreviewHeaderClass = "flex items-center gap-3";

export const profilePreviewNameClass =
	"block text-[15px] font-bold text-[var(--ink)]";

export const profilePreviewHandleClass =
	"block text-[14px] text-[var(--ink-soft)]";

export const profilePreviewBioClass =
	"block text-[14px] leading-[1.4] text-[var(--ink)]";

export const profilePreviewMetaClass =
	"block text-[13px] text-[var(--ink-soft)]";

/* Rich tweet text. */
export const tweetLinkClass = "text-[var(--accent)] hover:underline";

export const tweetMentionClass = "text-[var(--accent)] hover:underline";

export const tweetHashtagClass = tweetMentionClass;

/* Media grid (Twitter-style with rounded corners). */
export function tweetMediaGridClass(count: number) {
	const capped = Math.min(count, 4);
	const layout =
		count === 1
			? "grid-cols-1"
			: count === 3
				? "grid-cols-[1.3fr_1fr]"
				: count === 4
					? "grid-cols-2 grid-rows-2"
					: "grid-cols-2";

	return cx(
		`tweet-media-grid tweet-media-grid-${String(capped)}`,
		"mt-2 grid gap-0.5 overflow-hidden rounded-2xl border border-[var(--line)]",
		layout,
	);
}

export function tweetMediaTileClass(index: number, count: number) {
	return cx(
		"tweet-media-tile relative block overflow-hidden bg-[var(--bg-active)]",
		count === 1 && "aspect-[16/10]",
		count === 2 && "aspect-square",
		count === 3 && index === 0 && "row-span-2 aspect-[3/4]",
		count === 3 && index !== 0 && "aspect-square",
		count === 4 && "aspect-square",
	);
}

/* Inbox / triage card. */
export const inboxAnalysisClass =
	"mt-2 rounded-xl border border-[var(--line)] bg-[var(--bg-hover)] px-3 py-2.5 text-[14px] text-[var(--ink-soft)] [&_p]:mt-1 [&_p]:mb-0";

/* Block list item. */
export const blockRowClass =
	"flex items-start gap-3 border-b border-[var(--line)] px-4 py-3 transition-colors duration-150 hover:bg-[var(--bg-hover)]";

export const blockRowBodyClass = "flex min-w-0 flex-1 flex-col gap-1";

/* Aside (optional right column for stats). Hidden on small screens. */
export const asideShellClass =
	"sticky top-0 hidden h-screen w-[300px] shrink-0 flex-col gap-4 overflow-y-auto px-4 py-4 min-[1180px]:flex";

export const asideCardClass =
	"rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-4";

export const asideTitleClass = "text-[15px] font-bold text-[var(--ink)]";

export const asideStatRowClass =
	"flex items-baseline justify-between border-t border-[var(--line)] py-2 first:border-t-0 first:pt-0";

export const asideStatTermClass = "text-[13px] text-[var(--ink-soft)]";

export const asideStatValueClass = "text-[14px] font-bold text-[var(--ink)]";

/* Misc legacy aliases kept for compatibility while routes/components migrate. */
export const eyebrowClass =
	"text-[12px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]";

export const brandMarkClass = sidebarBrandTitleClass;

export const navClass = sidebarShellClass;

export const navLinksClass = sidebarNavClass;

export const heroShellClass = "flex flex-col gap-1 px-4 pt-3 pb-2";

export const heroShellDmClass = "";

export const heroControlsClass = "flex flex-wrap items-center gap-2 px-4 py-2";

export const heroControlsDmClass = "";

export const heroControlsBlocksClass = "";

export const heroTitleClass = pageTitleClass;

export const heroCopyClass = pageSubtitleClass;

export const surfaceCardClass =
	"rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)]";

export const contentCardClass = feedRowClass;

export const cardHeaderClass = "flex items-start justify-between gap-3";

export const cardFooterClass = "flex items-center justify-between gap-3";

export const identityBlockClass = "flex items-start gap-3";

export const identityRowClass =
	"flex flex-wrap items-center gap-1.5 text-[15px] text-[var(--ink-soft)]";

export const metaRowClass =
	"flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--ink-soft)]";

export const mutedDotClass =
	"inline-block size-1 shrink-0 rounded-full bg-[var(--ink-soft)]";

export const metaStackClass = "flex flex-col items-end gap-1";

export const pillClass =
	"inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold";

export const pillSoftClass = "bg-[var(--accent-soft)] text-[var(--accent)]";

export const pillAlertClass = "bg-[var(--alert-soft)] text-[var(--alert)]";

export const timestampClass = "text-[13px] text-[var(--ink-soft)]";

export const bodyCopyClass = feedRowTextClass;

export const inboxTitleClass = "text-[16px] font-bold text-[var(--ink)]";

export const metricRowClass =
	"flex flex-wrap items-center gap-3 text-[13px] text-[var(--ink-soft)]";

export const actionRowClass = "flex items-center gap-2";

export const feedPageClass = "flex w-full min-w-0 flex-col";

export const timelineLaneClass = feedClass;

export const inboxLaneClass = feedClass;

export const dmPageClass = "flex w-full min-w-0 flex-col";

export const stackGridClass = "flex flex-col";

/* Embedded tweet legacy aliases. */
export const embeddedTweetCardClass = embeddedCardClass;

export const embeddedTweetLabelClass = embeddedCardLabelClass;

export const embeddedTweetHeaderClass = embeddedCardHeaderClass;

export const embeddedTweetAuthorClass = "flex flex-wrap items-center gap-1.5";

export const embeddedTweetCopyClass = embeddedCardCopyClass;

/* DM legacy aliases (still used by DmWorkspace until rewrite). */
export const dmGridClass = dmShellClass;

export const dmListItemNonActive = "";

export const dmListCopyClass = dmListBodyClass;

export const dmPreviewTextClass = dmListPreviewClass;

export const threadShellClass = dmThreadClass;

export const threadHeaderClass = dmThreadHeaderClass;

export const threadTitleClass = dmThreadNameClass;

export const threadSubtitleClass = dmThreadSubtitleClass;

export const threadBioClass = "text-[14px] text-[var(--ink-soft)]";

export const threadDetailColumnClass =
	"flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-4";

export const threadDetailHeaderClass = "flex items-center gap-3";

export const messageStackClass = dmMessagesClass;

export const messageRowClass = dmMessageRowClass;

export const messageRowOutboundClass = dmMessageRowOutboundClass;

export const messageMetaClass = dmMessageMetaClass;

export const messageBubbleClass = dmMessageBubbleClass;

export const messageBubbleOutboundClass = dmMessageBubbleOutboundClass;

export const contextHandleClass = "text-[14px] text-[var(--ink-soft)]";

export const contextBioClass = "text-[14px] leading-[1.4] text-[var(--ink)]";

export const contextStatsClass = "flex flex-col gap-0";

export const contextStatRowClass =
	"flex items-baseline justify-between border-t border-[var(--line)] py-2 first:border-t-0 first:pt-0";

export const contextStatTermClass = "text-[13px] text-[var(--ink-soft)]";

export const contextStatValueClass = "text-[14px] font-bold text-[var(--ink)]";
