import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Exercise the installed CLI against a synthetic xurl process, with no Bird
// executable, user configuration, credentials, or real network requests.
export async function smokeWithoutBird({ directory, runCli }) {
	if (process.platform === "win32")
		return { skipped: "POSIX executable fixture" };
	const bin = path.join(directory, "bin");
	const home = path.join(directory, "home");
	const log = path.join(directory, "requests.jsonl");
	await mkdir(bin, { recursive: true });
	await mkdir(home, { recursive: true });
	await writeFile(path.join(bin, "xurl"), `#!${process.execPath}\n${fixture}`, {
		mode: 0o755,
	});
	const env = {
		PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
		HOME: home,
		BIRDCLAW_HOME: home,
		BIRDCLAW_CONFIG: path.join(home, "config.json"),
		BIRDCLAW_BIRD_COMMAND: path.join(bin, "bird-does-not-exist"),
		BIRDCLAW_BACKUP_AUTO_SYNC: "0",
		BIRDCLAW_XURL_RETRY_BASE_MS: "0",
		BIRDLESS_FIXTURE_LOG: log,
		DO_NOT_TRACK: "1",
	};
	let commands = 0;
	const run = async (args) => {
		const { stdout } = await runCli(["--json", ...args], env);
		commands++;
		const result = JSON.parse(stdout);
		assert.notEqual(result?.ok, false, `${args.join(" ")}: ${stdout}`);
		return result;
	};
	await run(["init", "--demo"]);
	await run(["auth", "use", "xurl"]);
	const authentication = await run(["auth", "status"]);
	assert.equal(authentication.installed, true);
	assert.equal(authentication.availableTransport, "xurl");
	for (const args of [
		["sync", "timeline", "--limit", "1", "--refresh"],
		["sync", "mentions", "--limit", "5", "--refresh"],
		["sync", "mention-threads", "--limit", "1", "--delay-ms", "0"],
		["sync", "likes", "--limit", "5", "--refresh"],
		["sync", "bookmarks", "--limit", "5", "--refresh"],
		["sync", "lists", "--max-lists", "1", "--delay-ms", "0"],
		["sync", "followers", "--limit", "1", "--yes"],
		["sync", "following", "--limit", "1", "--yes"],
		["dms", "sync", "--limit", "5", "--refresh"],
	])
		await run(args);
	const job = await run([
		"jobs",
		"sync-account",
		"--account",
		"acct_primary",
		"--limit",
		"5",
		"--max-pages",
		"1",
		"--refresh",
	]);
	assert.equal(job.steps.length, 6);
	assert.ok(job.steps.every((step) => step.ok && step.source === "xurl"));
	const audit = (
		await readFile(path.join(home, "audit/account-sync.jsonl"), "utf8")
	)
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.deepEqual(audit.at(-1), job);
	const secondary = await run([
		"jobs",
		"sync-account",
		"--account",
		"acct_studio",
		"--allow-bird-account",
		"--steps",
		"timeline,mentions,likes,bookmarks,dms",
		"--limit",
		"5",
		"--max-pages",
		"1",
		"--refresh",
	]);
	assert.ok(secondary.steps.every((step) => step.ok && step.source === "xurl"));
	for (const args of [
		["jobs", "sync-bookmarks", "--limit", "5", "--max-pages", "1", "--refresh"],
		["sync", "authored", "--limit", "5", "--max-pages", "1"],
		["mentions", "export", "--mode", "auto", "--limit", "5", "--refresh"],
		["import", "hydrate-profiles", "--account", "acct_primary"],
		["profiles", "replies", "@birdlessfixture", "--limit", "1"],
		["whois", "birdlessfixture"],
		["lists", "list"],
		["lists", "members", "Fixture List"],
		["graph", "summary"],
		["show", "tweet", "2000000000000000001"],
		["show", "thread", "2000000000000000001"],
	])
		await run(args);
	const messages = await run(["search", "dms", "birdless fixture"]);
	assert.ok(JSON.stringify(messages).includes("birdless fixture"));
	for (const args of [
		["research", "birdless", "--limit", "1"],
		["compose", "post", "synthetic post"],
		["compose", "reply", "2000000000000000001", "synthetic reply"],
		["compose", "dm", "dm_001", "synthetic DM"],
	])
		await run(args);
	await run(["auth", "use", "auto"]);
	for (const action of ["ban", "unban", "mute", "unmute"]) {
		const result = await run([action, "@birdlessfixture"]);
		assert.ok(JSON.stringify(result).includes("verified"));
	}
	const requests = (await readFile(log, "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(
		requests.filter((args) => args.includes("POST") || args.includes("DELETE"))
			.length,
		4,
	);
	return { commands, xurlInvocations: requests.length, birdInstalled: false };
}

const fixture = String.raw`
import { appendFileSync } from "node:fs";
const args=process.argv.slice(2);
appendFileSync(process.env.BIRDLESS_FIXTURE_LOG,JSON.stringify(args)+"\n");
const usernameIndex=args.indexOf("--username");
const username=usernameIndex<0?"steipete":args[usernameIndex+1];
const user={id:username==="birdclaw_lab"?"888":"25401953",username,name:"Demo account"};
const other={id:"777",username:"birdlessfixture",name:"Birdless Fixture",public_metrics:{followers_count:10}};
const out=value=>console.log(JSON.stringify(value));
if(args.includes("version")||args.includes("--version")){console.log("xurl synthetic");process.exit(0);}
if(args.includes("auth")&&args.includes("status")){console.log("oauth2: steipete");process.exit(0);}
if(args.includes("whoami")){out({data:user});process.exit(0);}
if(["post","reply","dm"].some(command=>args.includes(command))){out({data:{id:"2000000000000000200"}});process.exit(0);}
const endpoint=args.find(value=>value.startsWith("/2/"));
if(!endpoint)throw new Error("Unexpected xurl invocation: "+JSON.stringify(args));
const url=new URL(endpoint,"https://api.x.com");
const method=args.includes("-X")?args[args.indexOf("-X")+1]:"GET";
if(method!=="GET"){
 const field=url.pathname.includes("/blocking")?"blocking":url.pathname.includes("/muting")?"muting":null;
 if(!field)throw new Error("Unexpected mutation: "+url.pathname);
 out({data:{[field]:method==="POST"}});process.exit(0);
}
if(url.pathname==="/2/users/me"){out({data:user});process.exit(0);}
if(url.pathname==="/2/users/by"||url.pathname==="/2/users"){out({data:[other]});process.exit(0);}
if(url.pathname.endsWith("/owned_lists")){out({data:[{id:"900",name:"Fixture List",owner_id:user.id,member_count:1}],meta:{result_count:1}});process.exit(0);}
if(["/members","/followers","/following"].some(suffix=>url.pathname.endsWith(suffix))){out({data:[other],meta:{result_count:1}});process.exit(0);}
if(url.pathname==="/2/dm_events"){
 out({data:[{id:user.id==="888"?"2000000000000000101":"2000000000000000100",event_type:"MessageCreate",dm_conversation_id:user.id+"-777",sender_id:"777",participant_ids:[user.id,"777"],text:"birdless fixture message",created_at:new Date().toISOString()}],includes:{users:[user,other]},meta:{result_count:1}});process.exit(0);
}
const tweet={id:"2000000000000000001",author_id:"777",text:"birdless fixture tweet",created_at:new Date().toISOString(),conversation_id:"2000000000000000001",entities:{}};
if(url.pathname.includes("/tweets")||url.pathname.endsWith("/mentions")||url.pathname.endsWith("/liked_tweets")||url.pathname.endsWith("/bookmarks")||url.pathname.endsWith("/reverse_chronological")){
 const single=/^\/2\/tweets\/\d+$/.test(url.pathname);
 out({data:single?tweet:[tweet],includes:{users:[other]},meta:{result_count:1,newest_id:tweet.id}});process.exit(0);
}
throw new Error("Unexpected xurl endpoint: "+url.pathname);
`;
