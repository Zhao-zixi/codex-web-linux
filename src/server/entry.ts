import process from "node:process"
import { CLI_CHILD_MODE, CLI_CHILD_MODE_ENV_VAR } from "./restart"

// The one entry for `kanna`: the supervisor, or the server child it spawns
// (restart.ts). bin/kanna loads this from source in a checkout and from the
// bundle (scripts/build-server.ts) in the published package.
if (process.env[CLI_CHILD_MODE_ENV_VAR] === CLI_CHILD_MODE) {
  await import("./cli")
} else {
  await import("./cli-supervisor")
}
