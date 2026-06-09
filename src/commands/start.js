export default function register(bot) {
  bot.command("start", (ctx) =>
    ctx.reply("Welcome! Use /help to see available commands.")
  );
}
