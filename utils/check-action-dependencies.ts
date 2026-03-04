import * as fs from "fs";
import {
    collectIntraRepoDependencyGraph,
    findDependencyCycle,
    topologicallySortActions,
} from "./publish.ts";

const actionNames = fs
    .readdirSync("actions")
    .filter((name) => fs.statSync(`actions/${name}`).isDirectory());

const graph = collectIntraRepoDependencyGraph(actionNames);
const cycle = findDependencyCycle(graph);
if (cycle) {
    console.error(
        `Detected intra-repo action dependency cycle: ${cycle.join(" -> ")}`,
    );
    process.exit(1);
}

const order = topologicallySortActions(graph);
console.log(
    `Action dependency graph is acyclic. Topological order: ${order.join(
        ", ",
    )}`,
);
