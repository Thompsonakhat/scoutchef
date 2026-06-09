import "dotenv/config";

async function importMaybe(p) {
  try { return await import(p); }
  catch (e) {
    const alts = p.endsWith(".js") ? [p.replace(/\.js$/, ".mjs")] : [p + ".js", p + ".mjs"];
    for (const a of alts) { try { return await import(a); } catch {} }
    throw e;
  }
}

process.on("unhandledRejection", r => { console.error("UnhandledRejection:", r); process.exit(1); });
process.on("uncaughtException",  e => { console.error("UncaughtException:", e); process.exit(1); });

async function boot() {
  try {
    const { cfg } = await importMaybe("./lib/config.js");
    const { createBot } = await importMaybe("./bot.js");
    const { registerCommands } = await importMaybe("./commands/loader.js");

    if (!cfg?.TELEGRAM_BOT_TOKEN) {
      console.error("TELEGRAM_BOT_TOKEN is required. Add it to your env or .env and redeploy.");
      process.exit(1);
    }

    const bot = createBot(cfg.TELEGRAM_BOT_TOKEN);

    // Initialize bot info early so ctx.me / bot.botInfo is available for mention detection
    try { await bot.init(); } catch {}

    await registerCommands(bot);

    // 🔹 Automatically expose commands in Telegram's UI.
    // IMPORTANT FOR THE AI:
    // - Whenever you add or remove commands (bot.command("/xxx") in src/commands/*.js),
    //   you MUST also keep this list in sync so users see the right commands in the menu.
    try {
      await bot.api.setMyCommands([
        { command: "start", description: "Welcome & basic usage" },
        { command: "help", description: "How to use the bot" },
        // Add more entries matching the actual commands implemented for this bot.
        // e.g. { command: "meme", description: "Create a meme from text" },
        //      { command: "stats", description: "Show your stats" },
      ]);
    } catch (e) {
      console.warn("Failed to set bot commands:", e?.message ?? e);
    }

    await bot.start();
    console.log("Bot started.");
  } catch (err) {
    console.error("Boot error:", { code: err?.code, msg: String(err?.message || err) });
    if (err?.code === "ERR_MODULE_NOT_FOUND") {
      console.error("Check ESM extensions (.js/.mjs), file paths under src/, and that files exist.");
    }
    process.exit(1);
  }
}
boot();
