// The agent web page shows the conversation, accepts messages, and has an Approve button.
// A server-sent event stream sends updates to the browser over one open connection.
// The run serves the page on its web port, so you can also open it in Console under "Live view".
import http from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { watchEvents } from "@earendil-works/pi-durable";
import { ApprovalDoc, StatusDoc } from "./agent-tools.js";
import { formatTaskTree } from "./task-tree.js";
import type { Storage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

export type SteerServerOptions = {
	harness: Harness;
	storage: Storage;
	port: number;
	log: (line: string) => void;
	/** Return the repair conversation once the page comparison finishes and creates it. */
	conversation: () => Promise<{ id: unknown; submit: (draft: never, ctx: never) => Promise<unknown> } | undefined>;
	header: () => string;
};

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8"><title>Repair agent</title>
<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;grid-template-rows:auto 1fr auto;height:100vh}
header{padding:10px 16px;background:#111;color:#eee;font-size:14px;white-space:pre-wrap}#log{overflow:auto;padding:12px 16px;font-size:14px;line-height:1.45}
.ev{margin:4px 0;padding:6px 10px;border-radius:6px;background:#f3f3f3}.assistant{background:#e8f1ff}.tool{background:#fff6dc;font-family:ui-monospace,monospace;white-space:pre-wrap;font-size:12px}
.incident{background:#ffe3e3;font-family:ui-monospace,monospace;white-space:pre-wrap;font-size:12px}.steer{background:#e5ffe5;white-space:pre-wrap}.sys{color:#777;font-size:12px}
form{display:flex;gap:8px;padding:10px 16px;border-top:1px solid #ddd}input{flex:1;padding:8px;font-size:14px}button{padding:8px 14px;font-size:14px}#approve{background:#2a2;color:#fff;border:0}</style></head>
<body><header id="head">connecting…</header><div id="log"></div>
<form id="f"><input id="t" placeholder="Steer the agent (e.g. 'the site also added a cookie banner, handle it')" autocomplete="off"><button>Send</button><button type="button" id="approve">Approve promotion</button></form>
<script>
const log=document.getElementById('log'),head=document.getElementById('head');
function add(cls,text){const d=document.createElement('div');d.className='ev '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
let live={};
function render(ev){
 if(ev.type==='header'){head.textContent=ev.text;return}
 if(ev.type==='snapshot'){log.innerHTML='';add('sys','Saved entries before you join this run');for(const e of ev.entries){try{renderEntry(e)}catch(err){add('sys','could not render entry: '+err)}}add('sys','Live updates from here');return}
 if(ev.type==='entry_appended'||ev.type==='message_end'||ev.type==='tool_execution_end'){renderEntry(ev.entry);return}
 if(ev.type==='message_update'){const t=(ev.changes||[]).filter(c=>c.type==='text_delta').map(c=>c.delta).join('');if(!t)return;if(!live.msg)live.msg=add('assistant','');live.msg.textContent+=t;return}
 if(ev.type==='tool_execution_start'){live.msg=null;add('sys','tool call → '+ev.toolName+' '+JSON.stringify(ev.args).slice(0,300));return}
 if(ev.type==='run_start'){live.msg=null;add('sys','run started');return}
 if(ev.type==='run_end'){live.msg=null;add('sys','run ended ('+(ev.reason||'')+')');return}
 if(ev.type==='task_failed'){add('sys','task failed: '+JSON.stringify(ev).slice(0,300))}
}
function renderEntry(e){
 if(!e)return;live.msg=null;const k=e.kind||'';
 const msgs=Array.isArray(e.model)?e.model:[];
 const parts=msgs.flatMap(m=>Array.isArray(m.content)?m.content:[{type:'text',text:String(m.content==null?'':m.content)}]);
 const txt=parts.filter(p=>p.type==='text').map(p=>p.text).join('\\n');
 const data=e.data||{};
 if(k==='apify.incident'){add('incident',data.summary||txt||'incident');return}
 if(k==='apify.steer'){add('steer','STEER: '+(data.content||txt));return}
 if(k==='pi.reset'){add('steer','LATEST SAVED NOTES (entry #'+e.id+', conversation #'+e.conversationId+'):\\n'+txt);return}
 if(k==='pi.compaction'){add('sys','History summary: '+txt);return}
 if(k==='pi.user'){add('steer','you: '+txt);return}
 if(k==='pi.assistant'){if(txt)add('assistant',txt);for(const p of parts.filter(p=>p.type==='toolCall'))add('sys','tool call → '+p.name+' '+JSON.stringify(p.arguments||{}).slice(0,300));return}
 if(k==='pi.tool-result'||k==='pi.tool_result'){const m=msgs.find(m=>m.toolName)||{};add('tool',(m.toolName||data.toolName||'result')+': '+(txt||JSON.stringify(data).slice(0,600)).slice(0,1200));return}
 if(k==='pi.system'||k==='pi.usage'||k==='pi.provider'||k==='pi.head')return;
 add('sys',k+' '+(txt||JSON.stringify(data)).slice(0,300));
}
function connect(){const es=new EventSource('/events');es.onmessage=m=>{try{render(JSON.parse(m.data))}catch(err){add('sys','bad event '+err+' '+m.data.slice(0,200))}};es.onerror=()=>{add('sys','Live updates stopped. Reconnecting in 3 seconds');es.close();setTimeout(connect,3000)}}
connect();
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const t=document.getElementById('t');const text=t.value.trim();if(!text)return;t.value='';const r=await fetch('/steer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});add('sys','message sent: '+await r.text())};
document.getElementById('approve').onclick=async()=>{const by=prompt('Your name (recorded in the report):')||'anonymous';const r=await fetch('/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({by})});add('sys','approve: '+await r.text())};
</script></body></html>`;

export function startSteerServer(opts: SteerServerOptions): http.Server {
	const { harness, storage, log } = opts;
	const readBody = (req: http.IncomingMessage) =>
		new Promise<string>((resolve) => {
			let data = "";
			req.on("data", (c) => (data += c));
			req.on("end", () => resolve(data));
		});

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		try {
			if (req.headers["x-apify-container-server-readiness-probe"]) {
				res.writeHead(200);
				return res.end("ok");
			}
			if (url.pathname === "/" && req.method === "GET") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				return res.end(PAGE);
			}
			if (url.pathname === "/events") {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
				const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
				const headerTimer = setInterval(async () => {
					const inspection = await harness.inspect(context);
					const tree = await formatTaskTree(inspection, storage, context);
					const conv = await opts.conversation();
					const status = conv ? await harness.snapshot(StatusDoc, conv.id as never, context) : undefined;
					const approval = conv ? await harness.snapshot(ApprovalDoc, conv.id as never, context) : undefined;
					send({ type: "header", text: `${opts.header()}\nagent status: ${status?.phase ?? "starting"}${status?.note ? ` — ${status.note}` : ""}${status?.proposedBuildId ? ` (proposes build ${status.proposedBuildId})` : ""}${approval?.approved ? ` | APPROVED by ${approval.by}` : ""}\n${tree.join("\n")}` });
				}, 2000);
				const conv = await waitFor(opts.conversation, 120_000);
				if (!conv) {
					send({ type: "header", text: "no conversation yet" });
					return;
				}
				const stream = await watchEvents(harness, conv.id as never, context);
				send(stream.snapshot);
				stream.start(async (events) => {
					for (const event of events) send(event);
				});
				req.on("close", () => {
					clearInterval(headerTimer);
					stream.stop();
				});
				return;
			}
			if (url.pathname === "/steer" && req.method === "POST") {
				const { text } = JSON.parse(await readBody(req)) as { text: string };
				const conv = await opts.conversation();
				if (!conv) throw new Error("conversation not ready");
				await (conv.submit as (d: unknown, c: unknown) => Promise<unknown>)(
					{ type: "input", content: text, whenBusy: "steer", entry: { kind: "apify.steer", data: { content: text, at: new Date().toISOString() } } },
					context,
				);
				log(`STEER received: ${text}`);
				res.writeHead(200);
				return res.end("delivered; the agent sees it at its next turn");
			}
			if (url.pathname === "/approve" && req.method === "POST") {
				const { by } = JSON.parse(await readBody(req)) as { by?: string };
				const conv = await opts.conversation();
				if (!conv) throw new Error("conversation not ready");
				const status = await harness.snapshot(StatusDoc, conv.id as never, context);
				const handle = await harness.conversation(conv.id as never, context);
				if (!handle) throw new Error("conversation vanished");
				await handle.commit(async (tx) => {
					const doc = await tx.doc(ApprovalDoc, conv.id as never);
					doc.approved = true;
					doc.by = by || "anonymous";
					doc.at = new Date().toISOString();
					doc.buildId = status?.proposedBuildId ?? "";
				}, context);
				log(`APPROVED by ${by || "anonymous"} (committed to the agent's memory; survives a restart)`);
				res.writeHead(200);
				return res.end(`approved by ${by || "anonymous"}; the promote tool will proceed`);
			}
			res.writeHead(404);
			res.end("not found");
		} catch (error) {
			log(`steer server error on ${url.pathname}: ${(error as Error).message}`);
			if (!res.headersSent) res.writeHead(500);
			res.end(String((error as Error).message));
		}
	});
	server.listen(opts.port, () => log(`agent web page server listening on port ${opts.port}`));
	return server;
}

async function waitFor<T>(get: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = await get();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return undefined;
}
