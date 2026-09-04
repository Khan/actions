import {loadConfig} from "./config/load";
import {serve} from "./server";

serve(loadConfig(process.env.CONFIG_PATH ?? "config.json", true));
