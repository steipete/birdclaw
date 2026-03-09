export function cx(...values: Array<string | false | null | undefined>) {
	return values.filter(Boolean).join(" ");
}

export const bodyClass =
	"min-h-screen bg-[var(--bg)] font-sans text-[var(--ink)] antialiased transition-[background,color] duration-200";

export const siteShellClass =
	"mx-auto w-[min(1120px,calc(100vw-32px))] pb-12 pt-[18px] max-[760px]:w-[min(100vw-20px,100%)]";

export const pageWrapClass = "pt-6";

export const feedPageClass = "mx-auto grid w-full max-w-[960px] gap-6";

export const timelineLaneClass = "mx-auto grid w-full max-w-[680px] gap-4";

export const inboxLaneClass = "mx-auto grid w-full max-w-[760px] gap-4";

export const dmPageClass = "mx-auto grid w-full max-w-[1040px] gap-6";

export const eyebrowClass =
	"m-0 mb-2 text-[11px] uppercase tracking-[0.24em] text-[var(--ink-soft)]";

export const brandMarkClass =
	"m-0 max-w-[12ch] font-display text-[clamp(1.8rem,3vw,3.2rem)] leading-[0.95] font-semibold";

export const navClass =
	"flex items-end justify-between gap-6 border-b border-[var(--line)] py-[18px] pb-5 max-[760px]:flex-col max-[760px]:items-start";

export const navLinksClass = "nav-links flex flex-wrap items-center gap-2.5";

export const navLinkClass =
	"nav-link inline-flex items-center rounded-full border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_76%,transparent)] px-4 py-2.5 text-[var(--ink-soft)] transition duration-180 hover:-translate-y-px hover:border-[var(--line-strong)] hover:text-[var(--ink)]";

export const navLinkActiveClass =
	"nav-link-active border-[var(--line-strong)] bg-[var(--panel)] text-[var(--ink)] shadow-[0_16px_42px_var(--shadow)]";

export const heroShellClass =
	"flex items-end justify-between gap-6 py-7 pb-6 max-[760px]:flex-col max-[760px]:items-start";

export const heroShellDmClass = "items-start";

export const heroTitleClass =
	"m-0 max-w-[12ch] font-display text-[clamp(2.2rem,4vw,4.4rem)] leading-[0.95]";

export const heroCopyClass =
	"hero-copy mt-3.5 max-w-[46ch] text-base text-[var(--ink-soft)]";

export const heroControlsClass =
	"flex flex-wrap justify-end gap-3 max-[760px]:w-full max-[760px]:justify-start";

export const heroControlsDmClass = "max-w-[420px]";

export const heroControlsBlocksClass = "max-w-[560px]";

export const textFieldClass =
	"text-field w-full rounded-2xl border border-[var(--line)] bg-[var(--panel)] px-3.5 py-3 text-[var(--ink)] shadow-[0_18px_40px_var(--shadow)] outline-none transition duration-180 placeholder:text-[var(--ink-soft)] focus:border-[var(--line-strong)] disabled:cursor-default disabled:opacity-55";

export const textFieldWideClass = "w-[min(360px,100%)] max-[760px]:w-full";

export const textFieldShortClass =
	"text-field-short w-[140px] max-[760px]:w-full";

export const segmentedClass =
	"inline-flex gap-1.5 rounded-full border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_76%,transparent)] p-1.5";

export const segmentClass =
	"segment rounded-full border-0 bg-transparent px-3.5 py-2.5 text-[var(--ink-soft)] transition duration-180";

export const segmentActiveClass =
	"segment-active bg-[var(--panel)] text-[var(--ink)] shadow-[0_8px_22px_var(--shadow)]";

export const stackGridClass = "grid gap-4";

export const surfaceCardClass =
	"rounded-[24px] border border-[var(--line)] bg-[var(--panel)] shadow-[0_24px_60px_var(--shadow)]";

export const contentCardClass = cx("content-card", surfaceCardClass, "p-5");

export const cardHeaderClass =
	"flex items-start justify-between gap-3 max-[760px]:flex-col max-[760px]:items-start";

export const cardFooterClass =
	"flex items-center justify-between gap-3 max-[760px]:flex-col max-[760px]:items-start";

export const identityBlockClass = "flex items-start gap-3.5";

export const identityRowClass =
	"flex flex-wrap items-center gap-2.5 text-[0.92rem] text-[var(--ink-soft)]";

export const metaRowClass =
	"flex flex-wrap items-center gap-2.5 text-[0.92rem] text-[var(--ink-soft)]";

export const mutedDotClass =
	"muted-dot inline-block size-1 rounded-full bg-[var(--line-strong)]";

export const metaStackClass = "flex flex-col items-end gap-2";

export const pillClass =
	"pill inline-flex items-center rounded-full px-3 py-[7px] text-[0.76rem] uppercase tracking-[0.08em]";

export const pillSoftClass =
	"pill-soft bg-[var(--accent-soft)] text-[var(--accent)]";

export const pillAlertClass =
	"pill-alert bg-[var(--alert-soft)] text-[var(--alert)]";

export const timestampClass = "timestamp text-[0.9rem] text-[var(--ink-soft)]";

export const bodyCopyClass = "body-copy my-4 text-[1.08rem] leading-[1.6]";

export const inboxTitleClass = "inbox-title m-0 font-display text-[1.4rem]";

export const inboxAnalysisClass =
	"inbox-analysis pb-1 pt-4 text-[var(--ink-soft)] [&_p]:mt-2 [&_p]:mb-0";

export const metricRowClass =
	"metric-row flex flex-wrap gap-3.5 text-[0.9rem] text-[var(--ink-soft)]";

export const actionRowClass = "flex items-center gap-2.5";

export const actionButtonClass =
	"action-button inline-flex items-center justify-center rounded-full border-0 bg-[var(--ink)] px-4 py-[11px] text-sm font-medium text-white transition duration-180 hover:-translate-y-px disabled:cursor-default disabled:opacity-55";

export const errorCopyClass = "mb-4 text-[var(--alert)]";

export const composerShellClass =
	"mt-2.5 border-t border-[var(--line)] pt-[18px]";

export const composerInputClass =
	"composer-input min-h-[120px] w-full resize-y rounded-[18px] border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_88%,transparent)] px-4 py-4 text-[var(--ink)] shadow-[inset_0_1px_0_color-mix(in_srgb,white_36%,transparent)] outline-none transition duration-180 placeholder:text-[var(--ink-soft)] focus:border-[var(--line-strong)]";

export const composerBarClass =
	"flex items-center justify-between gap-4 pt-3 max-[760px]:flex-col max-[760px]:items-start";

export const linkPreviewCardClass =
	"grid gap-2.5 rounded-[20px] border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_84%,transparent)] px-4 py-3.5";

export const embeddedTweetCardClass = linkPreviewCardClass;

export const embeddedTweetLabelClass =
	"embedded-tweet-label m-0 text-[0.78rem] uppercase tracking-[0.12em] text-[var(--ink-soft)]";

export const embeddedTweetHeaderClass =
	"embedded-tweet-header flex items-center justify-between gap-2.5";

export const embeddedTweetAuthorClass =
	"embedded-tweet-author flex flex-wrap items-center gap-2.5 text-[var(--ink-soft)]";

export const embeddedTweetCopyClass =
	"embedded-tweet-copy m-0 text-[0.98rem] leading-[1.55]";

export const dmGridClass =
	"grid items-start gap-4 min-[980px]:grid-cols-[minmax(280px,320px)_minmax(0,1fr)] min-[1120px]:gap-5";

export const dmListClass = cx("dm-list", surfaceCardClass, "p-2.5");

export const dmListItemClass =
	"dm-list-item grid w-full grid-cols-[auto_1fr_auto] gap-3 rounded-[18px] border-0 bg-transparent p-3.5 text-left transition duration-180 hover:bg-[color:color-mix(in_srgb,var(--panel-strong)_72%,transparent)]";

export const dmListItemActiveClass =
	"dm-list-item-active bg-[color:color-mix(in_srgb,var(--panel-strong)_86%,transparent)]";

export const dmListCopyClass = "dm-list-copy min-w-0";

export const dmPreviewTextClass =
	"mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--ink-soft)]";

export const threadShellClass =
	"thread-shell min-h-[70vh] rounded-[24px] border border-[var(--line)] bg-[var(--panel)] p-[18px] shadow-[0_24px_60px_var(--shadow)]";

export const threadHeaderClass =
	"thread-header grid gap-5 border-b border-[var(--line)] pb-4 min-[860px]:grid-cols-[minmax(0,1fr)_minmax(220px,260px)]";

export const threadTitleClass = "m-0 font-display text-[2rem]";

export const threadSubtitleClass = "mt-1.5 text-[var(--ink-soft)]";

export const threadBioClass =
	"mt-2.5 max-w-[48ch] text-[var(--ink-soft)] leading-[1.55]";

export const threadDetailColumnClass =
	"grid gap-3 rounded-[20px] border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_82%,transparent)] p-4";

export const threadDetailHeaderClass = "flex items-center gap-3";

export const messageStackClass = "flex flex-col gap-3.5 py-5 pb-[18px]";

export const messageRowClass = "message-row max-w-[80%] max-[760px]:max-w-full";

export const messageRowOutboundClass = "message-row-outbound self-end";

export const messageMetaClass =
	"message-meta mb-2 flex justify-between gap-3 text-sm text-[var(--ink-soft)]";

export const messageBubbleClass =
	"rounded-[18px] rounded-bl-[6px] bg-[color:color-mix(in_srgb,var(--panel-strong)_86%,transparent)] px-4 py-3.5 leading-[1.55]";

export const messageBubbleOutboundClass =
	"rounded-bl-[18px] rounded-br-[6px] bg-[var(--accent-soft)]";

export const contextHandleClass = "mt-1.5 text-[var(--ink-soft)]";

export const contextBioClass = bodyCopyClass;

export const contextStatsClass = "mt-[18px] grid gap-3";

export const contextStatRowClass = "border-t border-[var(--line)] pt-3";

export const contextStatTermClass = "text-[0.84rem] text-[var(--ink-soft)]";

export const contextStatValueClass = "mt-1.5 font-semibold";

export const avatarChipClass =
	"avatar-chip inline-grid size-[42px] place-items-center overflow-hidden rounded-2xl font-bold text-white";

export const avatarChipLargeClass =
	"avatar-chip-large mb-3.5 size-16 rounded-[20px]";

export const emptyStateClass = "py-6 text-[var(--ink-soft)]";

export const profilePreviewClass = "profile-preview relative inline-flex";

export const profilePreviewTriggerClass =
	"profile-preview-trigger inline-flex text-inherit";

export const profilePreviewCardClass =
	"profile-preview-card pointer-events-none absolute left-0 top-[calc(100%+10px)] z-20 grid min-w-[240px] translate-y-1.5 gap-2.5 rounded-[18px] border border-[var(--line-strong)] bg-[var(--panel-strong)] p-3.5 opacity-0 shadow-[0_24px_60px_var(--shadow)] transition duration-160 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100";

export const profilePreviewHeaderClass =
	"profile-preview-header flex items-center gap-3";

export const profilePreviewHandleClass =
	"profile-preview-handle block text-[0.88rem] text-[var(--ink-soft)]";

export const profilePreviewBioClass =
	"profile-preview-bio block text-[0.95rem] leading-[1.5] text-[var(--ink)]";

export const profilePreviewMetaClass =
	"profile-preview-meta block text-[0.88rem] text-[var(--ink-soft)]";

export const tweetLinkClass =
	"tweet-link font-semibold text-[var(--accent)] underline decoration-[1px] underline-offset-[3px]";

export const tweetMentionClass =
	"tweet-mention font-semibold text-[color:color-mix(in_srgb,var(--accent)_78%,var(--ink))]";

export const tweetHashtagClass = tweetMentionClass;

export function tweetMediaGridClass(count: number) {
	const columns =
		count === 1
			? "grid-cols-1"
			: count === 3
				? "grid-cols-[1.3fr_1fr]"
				: "grid-cols-2";

	return cx(
		`tweet-media-grid tweet-media-grid-${Math.min(count, 4)}`,
		"mb-4 grid gap-2.5",
		columns,
	);
}

export function tweetMediaTileClass(index: number, count: number) {
	return cx(
		"tweet-media-tile overflow-hidden rounded-[20px] border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_88%,transparent)]",
		count === 3 && index === 0 && "row-span-2",
	);
}
