import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function smokeNativeDms({ directory, entry, runFixture }) {
	await mkdir(directory, { recursive: true });
	const launcher = path.join(directory, "native-fixture.mjs");
	const journal = path.join(directory, "requests.jsonl");
	await writeFile(
		launcher,
		fixture + `\nawait import(${JSON.stringify(pathToFileURL(entry).href)});\n`,
	);
	const env = {
		PATH: ["/usr/bin", "/bin"].join(path.delimiter),
		HOME: directory,
		BIRDCLAW_HOME: directory,
		BIRDCLAW_CONFIG: path.join(directory, "config.json"),
		BIRDCLAW_BIRD_COMMAND: path.join(directory, "bird-does-not-exist"),
		BIRDCLAW_BACKUP_AUTO_SYNC: "0",
		DO_NOT_TRACK: "1",
		AUTH_TOKEN: "native-fixture-auth-".repeat(2),
		CT0: "native-fixture-csrf-".repeat(2),
		BIRDLESS_FIXTURE_LOG: journal,
	};
	let commands = 0;
	const run = async (args) => {
		const { stdout } = await runFixture(launcher, ["--json", ...args], env);
		commands++;
		const result = JSON.parse(stdout);
		assert.notEqual(result?.ok, false);
		assert.notEqual(result?.success, false);
		return result;
	};
	await run(["init", "--demo"]);
	const sync = await run([
		"dms",
		"sync",
		"--mode",
		"web",
		"--inbox",
		"requests",
		"--limit",
		"5",
		"--refresh",
	]);
	assert.equal(sync.source, "web");
	assert.equal(sync.messages, 3);
	let requests = await run(["dms", "list", "--inbox", "requests"]);
	assert.ok(JSON.stringify(requests).includes("native request 777"));
	await run(["dms", "accept", "25401953-777"]);
	requests = await run(["dms", "list", "--inbox", "requests"]);
	assert.ok(!JSON.stringify(requests).includes("native request 777"));
	const accepted = await run(["dms", "list", "--inbox", "accepted"]);
	assert.ok(JSON.stringify(accepted).includes("native request 777"));
	await run(["dms", "reject", "25401953-778"]);
	await run(["dms", "block", "25401953-779"]);
	requests = await run(["dms", "list", "--inbox", "requests"]);
	assert.ok(!JSON.stringify(requests).includes("native request"));
	const calls = (await readFile(journal, "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(calls.filter((call) => call.method === "POST").length, 3);
	return {
		commands,
		httpRequests: calls.length,
		birdInstalled: false,
		browserInstalled: false,
	};
}

const fixture = String.raw`
import {appendFileSync} from 'node:fs';
const bearer='AAAAAA'+'SyntheticPublicWebToken'.repeat(3);
globalThis.fetch=async (input,init={})=>{
 const url=new URL(String(input));const method=init.method||'GET';
 appendFileSync(process.env.BIRDLESS_FIXTURE_LOG,JSON.stringify({path:url.pathname,method})+'\n');
 if(url.href==='https://x.com/')return new Response('<script src="https://abs.twimg.com/x-web/x-web/entry-client.js"></script>');
 if(url.pathname.endsWith('/entry-client.js'))return new Response('import "./guest-token.js";import "./viewer-query.js";');
 if(url.pathname.endsWith('/guest-token.js'))return new Response('const bearer="'+bearer+'";');
 if(url.pathname.endsWith('/viewer-query.js'))return new Response('const query={params:{id:"synthetic-viewer-query",metadata:{},name:"viewerQuery"}};');
 if(url.pathname.includes('/graphql/'))return Response.json({data:{viewer:{user_results:{result:{rest_id:'25401953',core:{screen_name:'steipete',name:'Demo account'}}}}}});
 if(url.pathname.endsWith('/inbox_initial_state.json')){
  const users={'25401953':{screen_name:'steipete',name:'Demo account'}};const conversations={};const entries=[];
  for(const id of ['777','778','779']){
   users[id]={screen_name:'nativefixture'+id,name:'Native Fixture '+id};
   const conversation_id='25401953-'+id;
   conversations[conversation_id]={conversation_id,trusted:false,participants:[{user_id:'25401953'},{user_id:id}]};
   entries.push({message:{id:'2000000000000000'+id,conversation_id,time:String(Date.now()),message_data:{sender_id:id,recipient_id:'25401953',text:'native request '+id}}});
  }
  return Response.json({inbox_initial_state:{users,conversations,entries,inbox_timelines:{untrusted:{status:'AT_END'},trusted:{status:'AT_END'}}}});
 }
 if(method==='POST'&&url.pathname.endsWith('/accept.json'))return new Response(null,{status:204});
 if(method==='POST'&&url.pathname.endsWith('/delete.json'))return Response.json({});
 if(method==='POST'&&url.pathname.endsWith('/blocks/create.json')){
  const target=new URLSearchParams(init.body).get('user_id');
  if(target!=='779')throw new Error('Unexpected block target');
  return Response.json({id_str:target,blocking:true});
 }
 throw new Error('Unexpected native fixture request: '+method+' '+url.pathname);
};
`;
