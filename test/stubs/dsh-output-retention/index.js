export class ItemRetainer {
	constructor(options) { this.options = options; this.items = []; this.seen = 0; }
	push(item) { this.items.push(item); this.seen += 1; }
	finish() { const max = this.options?.maxItems ?? this.items.length; return { items: this.items.slice(0, max), kept: Math.min(max, this.items.length), seen: this.seen, truncated: this.items.length > max }; }
}
export class TextRetainer {
	constructor(options) { this.options = options; this.lines = []; }
	push(line) { this.lines.push(line); }
	finish() { return { text: this.lines.join("\n"), kept: this.lines.length, seen: this.lines.length, truncated: false }; }
}
