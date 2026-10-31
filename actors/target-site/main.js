// The target site: a Standby Actor serving one product page. On every request it reads the record `variant`
// from its named KV store and serves markup variant `a` (original) or `b` (the redesign that breaks the
// scraper: price class renamed and nested, a cookie banner overlaying the list, a new consent script). The item
// markup itself (`li.product`, `.name`, `.rating`) stays, so only the price field goes missing.
import http from "node:http";
import { Actor } from "apify";

await Actor.init();

const STATE_STORE = process.env.STATE_STORE || "shd-target-site-state";
const store = await Actor.openKeyValueStore(STATE_STORE);

const NAMES = [
	"Aurora Desk Lamp", "Birch Bookshelf", "Cobalt Kettle", "Dune Floor Rug", "Ember Candle Set", "Fjord Chair",
	"Granite Mortar", "Harbor Throw", "Iris Vase", "Juniper Planter", "Kestrel Clock", "Lumen Mirror",
	"Moss Cushion", "Nimbus Duvet", "Orchard Tray", "Pebble Coasters", "Quill Notebook", "Reed Basket",
	"Slate Serving Board", "Tide Water Carafe",
];
const PRODUCTS = NAMES.map((name, i) => ({
	id: i + 1,
	name,
	price: (12.99 + i * 7.5).toFixed(2),
	oldPrice: i % 3 === 0 ? (20 + i * 9).toFixed(2) : null, // only some items carry a struck-through old price
	rating: (3.5 + ((i * 7) % 15) / 10).toFixed(1),
}));

const page = (variant) => {
	const items = PRODUCTS.map((p) =>
		variant === "a"
			? `<li class="product" data-id="${p.id}">
  <h3 class="name">${p.name}</h3>
  <span class="price-tag">$${p.price}</span>${p.oldPrice ? ` <span class="amount was">$${p.oldPrice}</span>` : ""}
  <span class="rating" data-rating="${p.rating}">★ ${p.rating}</span>
</li>`
			: `<li class="product" data-id="${p.id}">
  <h3 class="name">${p.name}</h3>
  <div class="pricing"><span class="product-price"><span class="currency">$</span><span class="value">${p.price}</span></span>${p.oldPrice ? `<s class="amount">$${p.oldPrice}</s>` : ""}</div>
  <span class="rating" data-rating="${p.rating}">★ ${p.rating}</span>
</li>`,
	).join("\n");
	const banner =
		variant === "b"
			? `<div id="cookie-consent" class="cookie-banner" role="dialog" style="position:fixed;inset:auto 0 0 0;padding:24px;background:#222;color:#fff;z-index:9;">
  We use cookies. <button class="consent-accept">Accept all</button> <button class="consent-reject">Reject</button>
</div>
<script src="/consent.js"></script>`
			: "";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Northwind Home Goods (${variant})</title>
<style>body{font-family:sans-serif;margin:24px}ul{list-style:none;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:12px}li{border:1px solid #ccc;padding:12px}.was,.amount{color:#999;text-decoration:line-through;margin-left:6px}.product-price{font-weight:bold}</style>
</head><body>
<h1>Northwind Home Goods</h1>
<p class="meta">Catalog variant: <b>${variant}</b></p>
<ul class="products">
${items}
</ul>
${banner}
</body></html>`;
};

const server = http.createServer(async (req, res) => {
	if (req.headers["x-apify-container-server-readiness-probe"]) {
		res.writeHead(200, { "content-type": "text/plain" });
		return res.end("ready");
	}
	const url = new URL(req.url, "http://x");
	if (url.pathname === "/consent.js") {
		res.writeHead(200, { "content-type": "application/javascript" });
		return res.end("document.querySelectorAll('.consent-accept,.consent-reject').forEach(b=>b.onclick=()=>document.getElementById('cookie-consent').remove());");
	}
	if (url.pathname === "/variant") {
		// Convenience for scripts: GET /variant reads it, GET /variant?set=b writes it.
		const set = url.searchParams.get("set");
		if (set === "a" || set === "b") await store.setValue("variant", set);
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ variant: (await store.getValue("variant")) || "a" }));
	}
	const variant = (await store.getValue("variant")) === "b" ? "b" : "a";
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(page(variant));
});

server.listen(Actor.config.get("containerPort") || 4321, () => console.log(`target site listening; state store ${STATE_STORE}`));
