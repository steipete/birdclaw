import { requestBackupAutoUpdate } from "#/lib/backup";
import { printError, type CliCommandContext } from "./command-context";

export function registerServeCommand(
	{ program, asJson, parseNonNegativeIntegerOption }: CliCommandContext,
	packageRoot: string,
	serverVersion: string,
) {
	program
		.command("serve")
		.description("Run the local web app and configured read-only MCP server")
		.option(
			"--host <host>",
			"Host interface to bind",
			process.env.BIRDCLAW_HOST ?? "127.0.0.1",
		)
		.option(
			"--port <port>",
			"TCP port (0 selects an available port)",
			process.env.BIRDCLAW_PORT ?? "3000",
		)
		.action(async (options) => {
			const host = String(options.host).trim();
			if (!host) {
				printError("--host must not be empty");
				process.exitCode = 1;
				return;
			}
			const port = parseNonNegativeIntegerOption(options.port, "--port");

			if (port > 65535) {
				printError("--port must be between 0 and 65535");
				process.exitCode = 2;
				return;
			}
			const { runProductionServer } = await import("#/lib/production-server");
			await runProductionServer({
				packageRoot,
				host,
				port,
				serverVersion,
				json: asJson(),
				onListening: () => requestBackupAutoUpdate(),
			});
		});
}
