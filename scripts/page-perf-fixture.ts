import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getNativeDb, resetDatabaseForTests } from "../src/lib/db";
const home =
	process.argv[2] ?? mkdtempSync(path.join(os.tmpdir(), "birdclaw-page-perf-"));
if (process.argv[2]) mkdirSync(home);
process.env.BIRDCLAW_HOME = home;
process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY = "0";
const db = getNativeDb({ seedDemoData: false });
if (
	!(db.prepare("select count(*) as n from accounts").get() as { n: number }).n
)
	db.transaction(() =>
		db.exec(`
 insert into accounts(id,name,handle,external_user_id,transport,is_default,created_at) values ('audit','Synthetic audit','audit','1','archive',1,'2026-01-01');
 with recursive seq(n) as (select 1 union all select n+1 from seq where n<100000)
 insert into profiles(id,handle,display_name,bio,followers_count,following_count,public_metrics_json,avatar_hue,location,created_at)
 select 'p'||n,'person'||n,'Synthetic Person '||n,'Synthetic software researcher and archive tester',100000-n,10,'{}',n%360,'City '||(n%1000),'2026-01-01' from seq;
 with recursive seq(n) as (select 1 union all select n+1 from seq where n<250000)
 insert into tweets(id,author_profile_id,text,created_at,is_replied,like_count)
 select 't'||n,'p'||(1+n%100000),
 'Synthetic archived post '||n||case when n%5000=0 or n%5000=7 then ' needle' else '' end,strftime('%Y-%m-%dT%H:%M:%fZ','2026-09-13T20:00:00Z','-'||n||' seconds'),n%2,n%500 from seq;
 insert into search_rows(kind,source_id) select 'tweet',id from tweets order by rowid;
 insert into tweets_fts(rowid,tweet_id,text) select r.id,t.id,t.text from tweets t join search_rows r on r.kind='tweet' and r.source_id=t.id order by r.id;
 insert into tweet_account_edges(account_id,tweet_id,kind,first_seen_at,last_seen_at,source,updated_at)
 select 'audit',id,case when rowid%10=0 then 'mention' when rowid%20=1 then 'authored' else 'home' end,created_at,created_at,'fixture',created_at from tweets;
 insert into tweet_collections(account_id,tweet_id,kind,collected_at,source,updated_at)
 select 'audit',id,case when rowid%2=0 then 'likes' else 'bookmarks' end,created_at,'fixture',created_at from tweets where rowid%5=0;
 with recursive seq(n) as (select 1 union all select n+1 from seq where n<40000)
 insert into dm_conversations(id,account_id,participant_profile_id,title,last_message_at,unread_count,needs_reply)
 select 'c'||n,'audit','p'||n,'Synthetic conversation '||n,strftime('%Y-%m-%dT%H:%M:%fZ','2026-09-13T20:00:00Z','-'||n||' seconds'),n%3,n%2 from seq;
 with recursive seq(n) as (select 1 union all select n+1 from seq where n<200000)
 insert into dm_messages(id,conversation_id,sender_profile_id,text,created_at,direction)
 select 'm'||n,'c'||(1+n%40000),'p'||(1+n%40000),'Synthetic message '||n||case when n%5000=0 then ' needle' else '' end,strftime('%Y-%m-%dT%H:%M:%fZ','2026-09-13T20:00:00Z','-'||n||' seconds'),'inbound' from seq;
 insert into search_rows(kind,source_id) select 'dm',id from dm_messages order by rowid;
 insert into dm_fts(rowid,message_id,text) select r.id,m.id,m.text from dm_messages m join search_rows r on r.kind='dm' and r.source_id=m.id order by r.id;
 insert into blocks(account_id,profile_id,source,created_at) select 'audit',id,'fixture','2026-09-13' from profiles where rowid%10=0;
 insert into follow_edges(account_id,direction,profile_id,external_user_id,source,current,first_seen_at,last_seen_at,updated_at)
 select 'audit','followers',id,id,'fixture',1,'2026-09-13','2026-09-13','2026-09-13' from profiles;
 with recursive seq(n) as (select 0 union all select n+1 from seq where n<999)
 insert into geocoded_locations(normalized_key,original,lat,lng,provider,hits,created_at,last_used_at)
 select 'city '||n,'City '||n,-70+n%140,-170+n%340,'opencage',1,'2026-09-13','2026-09-13' from seq;
 with recursive seq(n) as (select 1 union all select n+1 from seq where n<5000)
 insert into url_expansions(short_url,expanded_url,final_url,status,title,description,source,updated_at)
 select 'https://t.co/test'||n,case when n%5=0 then 'https://youtube.com/watch?v=synthetic'||n else 'https://example.invalid/article/'||n end,
 case when n%5=0 then 'https://youtube.com/watch?v=synthetic'||n else 'https://example.invalid/article/'||n end,'hit','Synthetic article '||n,'Synthetic fixture description','fixture','2026-09-13' from seq;
 insert into link_occurrences(source_kind,source_id,source_position,short_url,account_id,created_at)
 select 'tweet',id,0,'https://t.co/test'||(1+rowid%5000),'audit',created_at from tweets where rowid%10=0;
 update link_occurrences set short_url='https://t.co/test'||(1+(rowid/10)%5000);
`),
	)();
console.log(
	JSON.stringify({
		home,
		profiles: 100000,
		tweets: 250000,
		conversations: 40000,
		messages: 200000,
	}),
);
resetDatabaseForTests();
