declare const __BIRDCLAW_PUBLIC_READONLY__: boolean;

export const isPublicReadonlyBuild =
	typeof __BIRDCLAW_PUBLIC_READONLY__ !== "undefined" &&
	__BIRDCLAW_PUBLIC_READONLY__;

export function isPublicReadonlyWeb() {
	return (
		isPublicReadonlyBuild ||
		(typeof process !== "undefined" &&
			process.env.BIRDCLAW_WEB_PROFILE === "public-readonly")
	);
}
