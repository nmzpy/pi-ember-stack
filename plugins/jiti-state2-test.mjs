import { createJiti } from "jiti/static";
const j = createJiti("file:///C:/Users/nmz/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", { moduleCache: false });
const A = await j.import("C:/Work/pi-ember-stack/plugins/jiti-a.ts");
const B = await j.import("C:/Work/pi-ember-stack/plugins/jiti-b.ts");
const RI_A = await j.import("C:/Work/pi-ember-stack/plugins/pi-ember-ui/render-intent.ts");
const RI_B = await j.import("C:/Work/pi-ember-stack/plugins/pi-ember-ui/render-intent.ts");
const out = [];
out.push(`A.subscribe === B.subscribe: ${A.subscribe === B.subscribe}`);
// B subscribes a cb; A dispatches — shared subscriber set?
let ticks = 0;
B.subscribe(() => { ticks += 1; });
A.dispatch();
out.push(`A.dispatch ran B-subscribed cb: ${ticks === 1}`);
// A binds render-intent; B marks dirty; A dispatches → render fires.
let renders = 0;
RI_A.bind_render_intent(() => { renders += 1; });
B.request_render();
A.dispatch();
out.push(`A.render fired after B marked dirty: ${renders === 1}`);
// Phase shared?
A.activate("probe");
await new Promise((r) => setTimeout(r, 90));
out.push(`phase via B after A started clock: ${B.get_phase().toFixed(3)}`);
B.unsubscribe(() => {});
A.deactivate("probe");
RI_B.reset_render_intent();
console.log(out.join("\n"));
