export function isTcoUrl(url: string) {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === "t.co" || host.endsWith(".t.co");
	} catch {
		return false;
	}
}

const PRIVATE_IPV4_RANGES = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] satisfies Array<[string, number]>;

function ipv4ToNumber(value: string) {
	const parts = value.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
		return null;
	}
	if (parts.some((part) => part < 0 || part > 255)) return null;
	return (
		(parts[0] ?? 0) * 256 ** 3 +
		(parts[1] ?? 0) * 256 ** 2 +
		(parts[2] ?? 0) * 256 +
		(parts[3] ?? 0)
	);
}

function isIpv4InRange(address: string, range: string, prefix: number) {
	const addressNumber = ipv4ToNumber(address);
	const rangeNumber = ipv4ToNumber(range);
	if (addressNumber === null || rangeNumber === null) return false;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (addressNumber & mask) === (rangeNumber & mask);
}

function isPrivateIpv4(address: string) {
	return PRIVATE_IPV4_RANGES.some(([range, prefix]) =>
		isIpv4InRange(address, range, prefix),
	);
}

function normalizeIpv6(address: string) {
	return address.toLowerCase().replace(/^\[|\]$/g, "");
}

function parseIpv6Parts(address: string) {
	let normalized = normalizeIpv6(address);
	if (!normalized.includes(":")) return null;

	if (normalized.includes(".")) {
		const lastColon = normalized.lastIndexOf(":");
		const ipv4 = normalized.slice(lastColon + 1);
		const addressNumber = ipv4ToNumber(ipv4);
		if (addressNumber === null) return null;
		normalized = `${normalized.slice(0, lastColon + 1)}${(
			(addressNumber >>> 16) &
			0xffff
		).toString(16)}:${(addressNumber & 0xffff).toString(16)}`;
	}

	const halves = normalized.split("::");
	if (halves.length > 2) return null;
	const parseGroups = (value: string) =>
		value === ""
			? []
			: value.split(":").map((part) => Number.parseInt(part, 16));
	const left = parseGroups(halves[0] ?? "");
	const right = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
	const missingGroups = 8 - left.length - right.length;
	if (
		(halves.length === 1 && missingGroups !== 0) ||
		(halves.length === 2 && missingGroups < 0) ||
		![...left, ...right].every(
			(part) => Number.isInteger(part) && part >= 0 && part <= 0xffff,
		)
	) {
		return null;
	}
	return [...left, ...Array.from({ length: missingGroups }, () => 0), ...right];
}

function ipv4FromHexPair(parts: string[]) {
	if (parts.length !== 2) return null;
	const high = Number.parseInt(parts[0] ?? "", 16);
	const low = Number.parseInt(parts[1] ?? "", 16);
	if (
		![high, low].every(
			(part) => Number.isInteger(part) && part >= 0 && part <= 0xffff,
		)
	) {
		return null;
	}
	return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join(".");
}

function ipv4FromIpv6Parts(parts: number[]) {
	const tailIpv4 = () =>
		[
			(parts[6] >> 8) & 255,
			parts[6] & 255,
			(parts[7] >> 8) & 255,
			parts[7] & 255,
		].join(".");
	const hasZeroPrefix = (length: number) =>
		parts.slice(0, length).every((part) => part === 0);
	if (hasZeroPrefix(5) && parts[5] === 0xffff) return tailIpv4();
	if (hasZeroPrefix(4) && parts[4] === 0xffff && parts[5] === 0) {
		return tailIpv4();
	}
	if (hasZeroPrefix(6)) return tailIpv4();
	if (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 0) {
		return tailIpv4();
	}
	if (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 1) {
		return tailIpv4();
	}
	if (parts[0] === 0x2002) {
		return [
			(parts[1] >> 8) & 255,
			parts[1] & 255,
			(parts[2] >> 8) & 255,
			parts[2] & 255,
		].join(".");
	}
	return null;
}

function ipv4FromIpv6Suffix(address: string) {
	const normalized = normalizeIpv6(address);
	const parts = parseIpv6Parts(normalized);
	if (parts) return ipv4FromIpv6Parts(parts);
	const prefix = ["::ffff:", "64:ff9b::", "64:ff9b:1::", "::"].find((value) =>
		normalized.startsWith(value),
	);
	if (!prefix) return null;
	const suffix = normalized.slice(prefix.length);
	if (ipv4ToNumber(suffix) !== null) return suffix;
	return ipv4FromHexPair(suffix.split(":"));
}

function isPrivateIpv6(address: string) {
	const normalized = normalizeIpv6(address);
	const parts = parseIpv6Parts(normalized);
	const mappedIpv4 = parts
		? ipv4FromIpv6Parts(parts)
		: ipv4FromIpv6Suffix(normalized);
	if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
	if (parts) {
		const first = parts[0] ?? 0;
		return (
			parts.every((part) => part === 0) ||
			parts.slice(0, 7).every((part) => part === 0) ||
			(first & 0xfe00) === 0xfc00 ||
			(first & 0xffc0) === 0xfe80 ||
			(first & 0xffc0) === 0xfec0 ||
			(first & 0xff00) === 0xff00
		);
	}
	return false;
}

export function isBlockedAddress(address: string) {
	const normalized = address.replace(/^\[|\]$/g, "");
	if (ipv4ToNumber(normalized) !== null) return isPrivateIpv4(normalized);
	if (normalized.includes(":")) return isPrivateIpv6(normalized);
	return false;
}

export function isLocalHostname(hostname: string) {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal") ||
		normalized.endsWith(".test")
	);
}

export function assertSafePreviewUrl(url: string) {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Link preview URL must use http or https");
	}
	if (parsed.username || parsed.password) {
		throw new Error("Link preview URL must not include credentials");
	}
	if (isLocalHostname(parsed.hostname) || isBlockedAddress(parsed.hostname)) {
		throw new Error("Link preview URL points to a private host");
	}
	return parsed;
}

export function safeHttpUrl(value: string | null | undefined) {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		return parsed.toString();
	} catch {
		return null;
	}
}

export const __test__ = {
	assertSafePreviewUrl,
	ipv4FromIpv6Suffix,
	ipv4ToNumber,
	isBlockedAddress,
	isIpv4InRange,
	isPrivateIpv6,
	parseIpv6Parts,
	safeHttpUrl,
};
