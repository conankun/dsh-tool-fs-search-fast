export class HarnessError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
	}
}
