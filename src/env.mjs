import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

// Resolve against the project so npm, PM2, and direct CLI launches agree.
try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
