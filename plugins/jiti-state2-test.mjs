import { createJiti } from "jiti/static";
const j = createJiti("file:///C:/Users/nmz/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", { moduleCache: false });
const A = await j.import("C:/Work/pi-ember-stack/plugins/jiti-a.ts");
const B = await j.import("C:/Work/pi-ember-stack/plugins/jiti-b.ts");
const out = [];
out.push(`A.subscribe === B.subscribe: ${A.subscribe === B.subscribe}`);
// B subscribes a cb; A dispatches — shared subscriber set?
let ticks = 0;
B.subscribe(() => { ticks += 1; });
A.dispatch();
out.push(`A.dispatch ran B-subscribed cb: ${ticks === 1}`);
// A sets render request; B marks dirty; A dispatches.
let renders = 0;
A.set_render_request(() => { renders += 1; });
B.request_render();
A.dispatch();
out.push(`A.render fired after B marked dirty: ${renders === 1}`);
// Phase shared?
A.activate("probe");
await new Promise((r) => setTimeout(r, 90));
out.push(`phase via B after A started clock: ${B.get_phase().toFixed(3)}`);
B.unsubscribe(() => {});
A.deactivate("probe");
A.set_render_request(undefined);
console.log(out.join("\n"));
