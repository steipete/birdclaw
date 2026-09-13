import type { Command } from "commander";

export class CliInputError extends Error {}

const thresholds = new Set([
	"minFollowers",
	"maxFollowers",
	"minInfluenceScore",
	"maxInfluenceScore",
	"minScore",
]);

export function configureNumericOptions(program: Command) {
	program.hook("preAction", (_root, command) => {
		for (const option of command.options) {
			if (!/<(?:n|seconds|port)>/.test(option.flags)) continue;
			const name = option.attributeName();
			const value: unknown = command.getOptionValue(name);
			if (value === undefined) continue;
			const text = String(value).trim();
			const number = Number(text);
			if (thresholds.has(name)) {
				if (!text || !Number.isFinite(number)) {
					throw new CliInputError(`${option.long} must be a finite number`);
				}
			} else if (name === "cacheTtl") {
				if (!text || !Number.isFinite(number) || number < 0) {
					throw new CliInputError(
						`${option.long} must be a non-negative finite number`,
					);
				}
			} else if (!text || !Number.isSafeInteger(number) || number < 0) {
				throw new CliInputError(
					`${option.long} must be a non-negative integer`,
				);
			}
		}
	});
}
