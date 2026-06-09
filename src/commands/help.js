export default function register(bot) {
  bot.command("help", (ctx) =>
    ctx.reply("Available commands: /start, /health, /help")
  );
}
