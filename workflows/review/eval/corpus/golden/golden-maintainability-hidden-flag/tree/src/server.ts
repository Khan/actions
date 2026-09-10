import {createServer} from "node:http";
import type {Config} from "./config/types";

export const serve = (config: Config): void => {
    createServer((_request, response) => {
        response.writeHead(200, {"content-type": "text/plain"});
        response.end(config.name);
    }).listen(config.port);
};
