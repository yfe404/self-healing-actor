// Selector decisions for the target site. The repair agent edits this file.
export const SELECTORS = {
	item: "li.product",
	name: ".name",
	price: ".price-tag",
	rating: ".rating",
};

const money = (text) => {
	const match = /([0-9]+(?:\.[0-9]+)?)/.exec((text || "").replace(/,/g, ""));
	return match ? Number(match[1]) : null;
};

export function extract($, el) {
	const text = (selector) => {
		const node = el.find(selector).first();
		return node.length ? node.text().trim() : null;
	};
	return {
		id: el.attr("data-id") ?? null,
		name: text(SELECTORS.name),
		price: money(text(SELECTORS.price)),
		rating: el.find(SELECTORS.rating).first().attr("data-rating") ? Number(el.find(SELECTORS.rating).first().attr("data-rating")) : null,
	};
}
