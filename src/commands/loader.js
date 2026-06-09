import fs from "fs";
import path from "path";

export async function registerCommands(bot) {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);

  const commandFiles = fs
    .readdirSync(__dirname)
    .filter(
      (file) =>
        file.endsWith(".js") &&
        file !== "loader.js" &&
        !file.startsWith("_")
    );

  for (const file of commandFiles) {
    const filePath = "./" + file;
    const mod = await import(filePath);

    const handler =
      (mod && (mod.default || mod.register || mod.command || mod.handler)) ||
      (typeof mod === "function" ? mod : null);

    if (typeof handler === "function") {
      await handler(bot);
    } else {
      console.warn("[commands] " + file + " has no usable export; skipped.");
    }
  }
}
