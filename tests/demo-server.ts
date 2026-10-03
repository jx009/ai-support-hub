import { fixture } from "./fixture.js";
const f = await fixture(4088);
f.worker.start();
console.log("Demo ready on " + f.config.PUBLIC_URL);
process.on("SIGTERM", () => void f.close());
process.on("SIGINT", () => void f.close());
