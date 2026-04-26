import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

async function main() {
  await mkdir(path.join(root, "client"), { recursive: true });
  await writeFile(path.join(root, "client", ".env.local"), "VITE_API_BASE=/api\n", "utf8");

  await runCommand("npm", ["--prefix", "client", "run", "build"]);
  await runCommand("npx", ["firebase", "emulators:start", "--only", "hosting,functions,firestore"]);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
