import { Monitor, Moon, Sun } from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";
import { useMemo } from "react";
import { type ThemeValue, useTheme } from "#/lib/theme";
import {
	startThemeTransition,
	type ThemeTransitionContext,
} from "#/lib/theme-transition";
import { cx } from "#/lib/ui";

const THEME_OPTIONS = [
	{ key: "system", icon: Monitor, label: "System default" },
	{ key: "light", icon: Sun, label: "Light theme" },
	{ key: "dark", icon: Moon, label: "Dark theme" },
] as const satisfies Array<{
	key: ThemeValue;
	icon: typeof Sun;
	label: string;
}>;

const ACTIVE_ITEM_WIDTH_PX = 30;
const GAP_PX = 6;
const CONTAINER_PADDING_PX = 6;
const INDICATOR_SIZE_PX = 30;
const INDICATOR_OVERHANG_PX = (INDICATOR_SIZE_PX - ACTIVE_ITEM_WIDTH_PX) / 2;
const INDICATOR_BASE_OFFSET_PX = CONTAINER_PADDING_PX - INDICATOR_OVERHANG_PX;

function toPx(value: number) {
	return `${String(value)}px`;
}

export function ThemeSlider() {
	const { isReady, theme, resolvedTheme, setTheme } = useTheme();

	const activeIndex = useMemo(() => {
		const index = THEME_OPTIONS.findIndex((option) => option.key === theme);
		return index === -1 ? 0 : index;
	}, [theme]);

	const indicatorOffset = activeIndex * (ACTIVE_ITEM_WIDTH_PX + GAP_PX);
	const indicatorStyle = useMemo<CSSProperties>(
		() => ({
			left: toPx(INDICATOR_BASE_OFFSET_PX),
			transform: `translate(${toPx(indicatorOffset)}, -50%)`,
		}),
		[indicatorOffset],
	);
	const sliderStyle = useMemo<CSSProperties>(
		() => ({
			gridTemplateColumns: `repeat(${String(THEME_OPTIONS.length)}, ${toPx(ACTIVE_ITEM_WIDTH_PX)})`,
			columnGap: toPx(GAP_PX),
			padding: `0 ${toPx(CONTAINER_PADDING_PX)}`,
			width: toPx(
				THEME_OPTIONS.length * ACTIVE_ITEM_WIDTH_PX +
					(THEME_OPTIONS.length - 1) * GAP_PX +
					CONTAINER_PADDING_PX * 2,
			),
		}),
		[],
	);

	return (
		<fieldset
			className="theme-slider-shell m-0 border-0 p-0"
			aria-label="Theme selector"
		>
			<div
				className="theme-slider relative grid h-[42px] place-items-center overflow-hidden rounded-full border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel-strong)_86%,transparent)] shadow-[inset_0_1px_0_color-mix(in_srgb,white_40%,transparent)] transition-[background,border-color] duration-180"
				style={sliderStyle}
			>
				<div
					className={cx(
						"theme-slider-indicator pointer-events-none absolute top-1/2 z-0 size-[30px] rounded-full border border-[color:color-mix(in_srgb,var(--line-strong)_85%,transparent)] bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.6),transparent_58%),var(--panel-strong)] shadow-[0_10px_24px_var(--shadow),inset_0_1px_0_rgba(255,255,255,0.35)] transition-[transform,background,border-color,box-shadow] duration-220 ease-[cubic-bezier(0.22,1,0.36,1)]",
						resolvedTheme === "dark" &&
							"theme-slider-indicator-dark shadow-[0_10px_24px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.08)]",
					)}
					style={indicatorStyle}
				/>
				{THEME_OPTIONS.map((option, index) => {
					const Icon = option.icon;
					const isActive = index === activeIndex;

					const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
						if (isActive) return;

						const context: ThemeTransitionContext = {
							element: event.currentTarget,
							pointerClientX: event.clientX,
							pointerClientY: event.clientY,
						};

						startThemeTransition({
							nextTheme: option.key,
							currentTheme: theme,
							setTheme,
							context,
						});
					};

					return (
						<button
							key={option.key}
							type="button"
							className={cx(
								"theme-slider-button relative z-[1] inline-flex size-[30px] items-center justify-center rounded-full border-0 bg-transparent text-[var(--ink-soft)] transition-[color,transform] duration-160 hover:-translate-y-px hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[color:color-mix(in_srgb,var(--accent)_54%,transparent)]",
								isActive && "theme-slider-button-active text-[var(--ink)]",
							)}
							onClick={handleClick}
							aria-label={option.label}
							aria-pressed={isActive}
							data-testid={`theme-${option.key}`}
							disabled={!isReady}
						>
							<Icon
								className="theme-slider-icon size-[15px]"
								strokeWidth={1.8}
							/>
						</button>
					);
				})}
			</div>
		</fieldset>
	);
}
