// Test-only: a stand-in for the bridge. It starts one build in the box and never stops it; the test kills this
// process and checks that the build's processes went with it. argv: <folder> <packages>
import { createResourceLauncher } from "../agents/resource-group.mjs";
import { createBuildBox } from "./box.mjs";

const [folder, packages] = process.argv.slice(2);
const result = await createBuildBox({ launcher: createResourceLauncher() }).build({ folder, packages });
console.log(JSON.stringify(result));
