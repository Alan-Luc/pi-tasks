import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HumanInputIdentity = Readonly<{ sessionId: string; entryId: string }>;
export type HumanInputContext = Pick<ExtensionContext, "sessionManager">;

type PendingInput = { anchor: string | null; inputs: Array<{ human: boolean; text: string }> };

function messageText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

export function registerHumanInputTracker(pi: ExtensionAPI) {
	let sessionId: string | undefined;
	let pending: PendingInput | undefined;
	const humanEntries = new Set<string>();
	const activate = (ctx: HumanInputContext) => {
		const currentId = ctx.sessionManager.getSessionId();
		if (currentId !== sessionId) {
			sessionId = currentId;
			pending = undefined;
			humanEntries.clear();
		}
	};
	const reconcile = (ctx: HumanInputContext) => {
		activate(ctx);
		if (!pending) return;
		const branch = ctx.sessionManager.getBranch();
		const anchorIndex = pending.anchor === null ? -1 : branch.findIndex((entry) => entry.id === pending?.anchor);
		if (pending.anchor !== null && anchorIndex < 0) return;
		const users = branch.slice(anchorIndex + 1).flatMap((entry) => entry.type === "message" && entry.message.role === "user"
			? [{ id: entry.id, text: messageText(entry.message.content) }] : []);
		if (users.length !== pending.inputs.length) return;
		const human = pending.inputs[0].human;
		// Mixed-source queued inputs cannot be assigned native entry IDs unambiguously.
		if (pending.inputs.some((input) => input.human !== human)) return;
		const expected = pending.inputs.map((input) => input.text).sort();
		const actual = users.map((entry) => entry.text).sort();
		// Text correlates native source events and new branch entries; it is not authority alone.
		if (expected.some((text, index) => text !== actual[index])) return;
		if (human) for (const entry of users) humanEntries.add(entry.id);
		pending = undefined;
	};
	pi.on("session_start", (_event, ctx) => activate(ctx));
	pi.on("session_shutdown", () => {
		sessionId = undefined;
		pending = undefined;
		humanEntries.clear();
	});
	pi.on("session_tree", () => { pending = undefined; });
	pi.on("input", (event, ctx) => {
		activate(ctx);
		if (!pending || event.streamingBehavior === undefined) pending = { anchor: ctx.sessionManager.getLeafId(), inputs: [] };
		pending.inputs.push({ human: event.source === "interactive" || event.source === "rpc", text: event.text });
	});
	pi.on("context", (_event, ctx) => { reconcile(ctx); });
	return {
		current(ctx: HumanInputContext): HumanInputIdentity | undefined {
			reconcile(ctx);
			if (pending?.inputs.some((input) => input.human)) return undefined;
			const branch = ctx.sessionManager.getBranch();
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				const entry = branch[index];
				if (humanEntries.has(entry.id)) return { sessionId: ctx.sessionManager.getSessionId(), entryId: entry.id };
			}
			return undefined;
		},
		isHumanEntry(ctx: HumanInputContext, entryId: string): boolean {
			reconcile(ctx);
			return humanEntries.has(entryId) && ctx.sessionManager.getBranch().some((entry) => entry.id === entryId);
		},
	};
}
