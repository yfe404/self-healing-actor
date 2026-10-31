// The permanent link opens the agent web page served by the current repair run.
// Apify's Standby mode starts this web server on request, so you keep the same link between repair runs.
import http from "node:http";
import { Actor } from "apify";
import { ApifyClient } from "apify-client";

await Actor.init();
const REPAIR_ACTOR = process.env.REPAIR_ACTOR; // user/name
const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

const server = http.createServer(async (req, res) => {
	if (req.headers["x-apify-container-server-readiness-probe"]) {
		res.writeHead(200, { "content-type": "text/plain" });
		return res.end("ready");
	}
	try {
		const runs = await client.actor(REPAIR_ACTOR).runs().list({ status: "RUNNING", desc: true, limit: 5 });
		const run = runs.items[0];
		if (run) {
			const full = await client.run(run.id).get();
			if (full?.containerUrl) {
				res.writeHead(302, { location: full.containerUrl, "cache-control": "no-store" });
				return res.end();
			}
		}
		res.writeHead(200, { "content-type": "text/html", refresh: "5" });
		res.end(`<!doctype html><title>Repair agent</title><body style="font-family:sans-serif;padding:24px"><h1>No repair run is active right now.</h1><p>This page refreshes every 5 seconds and will redirect to the agent as soon as a run starts.</p></body>`);
	} catch (error) {
		res.writeHead(500, { "content-type": "text/plain" });
		res.end(String(error));
	}
});
server.listen(Actor.config.get("containerPort") || 4321, () => console.log(`redirector for ${REPAIR_ACTOR}`));
