// Draw a page picture from its HTML without opening a browser. The same HTML gives the same picture.
// Draw the product grid and the cookie banner so you can compare the old and new pages side by side.
// Chromium, a web browser, is outside the scope of these pictures.
import * as cheerio from "cheerio";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderPageSvg(html: string, caption: string): string {
	const $ = cheerio.load(html);
	const title = $("h1").first().text().trim() || $("title").text().trim();
	const items = $("li[data-id], li.product, li.product-card")
		.map((_, el) => {
			const li = $(el);
			const priceNode = li.find(".price-tag, .product-price, [class*=price]").first();
			return {
				name: li.find(".name, h3").first().text().trim(),
				price: priceNode.length ? priceNode.text().replace(/\s+/g, "").trim() : "",
				priceClass: priceNode.length ? (priceNode.attr("class") ?? "") : "(none)",
				rating: li.find(".rating").first().text().trim(),
			};
		})
		.get();
	const banner = $("#cookie-consent, .cookie-banner, [class*=consent], [class*=cookie]").first();
	const cols = 4;
	const cardW = 190;
	const cardH = 78;
	const gap = 10;
	const top = 70;
	const rows = Math.ceil(items.length / cols);
	const width = 20 + cols * (cardW + gap);
	const height = top + rows * (cardH + gap) + 60;
	const cards = items
		.map((item, i) => {
			const x = 20 + (i % cols) * (cardW + gap);
			const y = top + Math.floor(i / cols) * (cardH + gap);
			const priceText = item.price ? `${item.price}  (${item.priceClass})` : "NO PRICE FOUND";
			return `<g transform="translate(${x},${y})">
  <rect width="${cardW}" height="${cardH}" fill="#fff" stroke="#bbb"/>
  <text x="8" y="20" font-size="12" font-weight="bold">${esc(item.name.slice(0, 26))}</text>
  <text x="8" y="42" font-size="12" fill="${item.price ? "#0a0" : "#c00"}">${esc(priceText.slice(0, 30))}</text>
  <text x="8" y="62" font-size="11" fill="#555">${esc(item.rating)}</text>
</g>`;
		})
		.join("\n");
	const bannerSvg = banner.length
		? `<g>
  <rect x="0" y="${height - 56}" width="${width}" height="56" fill="#222" opacity="0.92"/>
  <text x="16" y="${height - 24}" font-size="14" fill="#fff">OVERLAY: ${esc(banner.text().replace(/\s+/g, " ").trim().slice(0, 70))}</text>
</g>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif">
<rect width="100%" height="100%" fill="#f5f5f5"/>
<text x="20" y="28" font-size="18" font-weight="bold">${esc(title)}</text>
<text x="20" y="50" font-size="12" fill="#666">${esc(caption)}; ${items.length} items, ${items.filter((i) => i.price).length} with a price${banner.length ? "; cookie banner present" : ""}</text>
${cards}
${bannerSvg}
</svg>`;
}

/** The page comparison uses these facts: matching page elements, scripts, and suspicious class names. */
export function pageFacts(html: string, selectors: Record<string, string>) {
	const $ = cheerio.load(html);
	const selectorMatches: Record<string, number> = {};
	for (const [field, selector] of Object.entries(selectors)) {
		try {
			selectorMatches[field] = $(selector).length;
		} catch {
			selectorMatches[field] = -1;
		}
	}
	const scripts = $("script")
		.map((_, el) => $(el).attr("src") ?? `inline:${($(el).html() ?? "").slice(0, 40)}`)
		.get();
	const classes = new Set<string>();
	$("[class]").each((_, el) => {
		for (const c of ($(el).attr("class") ?? "").split(/\s+/)) if (c) classes.add(c);
	});
	const ids = new Set<string>();
	$("[id]").each((_, el) => {
		ids.add($(el).attr("id") ?? "");
	});
	return { selectorMatches, scripts, classes: [...classes].sort(), ids: [...ids].sort(), bytes: html.length };
}

export const SUSPICIOUS = /price|cookie|consent|banner|amount|cost/i;
