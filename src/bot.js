import { Bot } from "grammy";
import { cfg } from "./lib/config.js";
import { addTurn, getRecentTurns, clearUserMemory } from "./lib/memory.js";
import { aiSmartChat } from "./lib/ai.js";
import { BOT_PROMPT } from "./lib/botProfile.js";

export function createBot(token) {
  const bot = new Bot(token);

  bot.command("start", (ctx) => ctx.reply("✅ Bot is running. Type anything to chat."));
  bot.command("help", (ctx) => ctx.reply("Commands: /start, /help, /reset"));
  bot.command("reset", async (ctx) => {
    await clearUserMemory({
      mongoUri: cfg.MONGODB_URI,
      platform: "telegram",
      userId: ctx.from?.id,
      chatId: ctx.chat?.id,
    });
    await ctx.reply("✅ Memory cleared for this chat.");
  });

// Catch-all text handler MUST NOT swallow commands.
// In groups: only reply when the bot is mentioned (@botusername) OR the message is a reply to the bot.
bot.on("message:text", async (ctx, next) => {
  const raw = (ctx.message && ctx.message.text) ? ctx.message.text : "";
  if (raw.startsWith("/")) return next();

  const chatType = (ctx.chat && ctx.chat.type) ? ctx.chat.type : "private";
  const isPrivate = chatType === "private";

  const botUsername =
    (ctx.me && ctx.me.username) ||
    (ctx.botInfo && ctx.botInfo.username) ||
    "";

  const replyTo = ctx.message ? ctx.message.reply_to_message : undefined;

  const isReplyToBot =
    !!(replyTo && replyTo.from && replyTo.from.is_bot) &&
    !!botUsername &&
    String((replyTo.from && replyTo.from.username) || "").toLowerCase() === String(botUsername).toLowerCase();

  // Detect "@botusername" mention entity
  const ents = (ctx.message && Array.isArray(ctx.message.entities)) ? ctx.message.entities : [];
  const isMentioned = !!botUsername && ents.some((e) => {
    if (!e || e.type !== "mention") return false;
    const s = raw.slice(e.offset, e.offset + e.length);
    return s.toLowerCase() === ("@" + String(botUsername).toLowerCase());
  });

  // In group chats, ignore messages unless mentioned or replied-to
  if (!isPrivate && !isMentioned && !isReplyToBot) return next();

  // Clean mention from the text so the agent sees the user's actual request
  let t = raw;
  if (botUsername) {
    const re = new RegExp("@" + String(botUsername) + "\b", "ig");
    t = t.replace(re, "").trim();
  }

  if (!t) {
    // If user only wrote "@botusername" with no text
    return ctx.reply("Hey 👋 What should I help you with?");
  }

  const userId = ctx.from ? ctx.from.id : undefined;
  const chatId = ctx.chat ? ctx.chat.id : undefined;

  // Save user message
  await addTurn({
    mongoUri: cfg.MONGODB_URI,
    platform: "telegram",
    userId,
    chatId,
    role: "user",
    text: t,
  });

  const history = await getRecentTurns({
    mongoUri: cfg.MONGODB_URI,
    platform: "telegram",
    userId,
    chatId,
    limit: 14,
  });

  // If natural chat is enabled, answer via AI about THIS bot (commands/features/config),
  // otherwise fallback to the old "recent context" debug reply.
  const naturalChatOn = cfg.NATURAL_CHAT_MODE !== false;

  let reply = "";

  if (naturalChatOn) {
    const botName = botUsername ? ("@" + botUsername) : "this bot";

    const system = [
      "You are a Telegram bot generated on CookMyBots.",
      "Your ONLY job is to help users understand and use THIS bot.",
      "Answer questions about: what the bot does, its commands, how to use it, and its behavior.",
      "If a user asks unrelated/general questions, politely say you only answer about this bot and suggest /help.",
      "",
      "Bot spec/prompt (generation context):",
      String(BOT_PROMPT || "").slice(0, 2000),
      "",
      "Known commands in this bot:",
      "- /start",
      "- /help",
      "- /reset",
      "",
      "Notes:",
      "- In groups, the bot only responds when mentioned or replied-to.",
      "- The bot name is " + botName + ".",
    ].join("\n");

    // Use stored memory as context
    const msgs = [
      { role: "system", content: system },
      ...history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.text || "").slice(0, 2000),
      })),
    ];

    const res = await aiSmartChat(cfg, t, { system, retries: 1, meta: { platform: "telegram", chatId: ctx.chat?.id, userId: ctx.from?.id } });

    // Extract text safely (different gateways may shape response differently)
    const aiText =
      (res && res.json && (res.json.text || res.json.message)) ||
      (res && res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message && res.json.choices[0].message.content) ||
      (res && res.text) ||
      "";

    if (res?.ok && String(aiText || "").trim()) {
      reply = String(aiText).trim();
    } else if (res?.status === 412) {
      reply = "I can help you use this bot. Add the AI env keys (COOKMYBOTS_AI_ENDPOINT/COOKMYBOTS_AI_KEY) or type /help.";
    } else {
      reply = "I can help you use this bot. Type /help to see commands.";
    }
  } else {
    // Old debug fallback
    const last = history
      .slice(-6)
      .map((m) => String(m.role) + ": " + String(m.text))
      .join("\n");

    reply = "Got it.\n\nRecent context:\n" + last;
  }

  await addTurn({
    mongoUri: cfg.MONGODB_URI,
    platform: "telegram",
    userId,
    chatId,
    role: "assistant",
    text: reply,
  });

  await ctx.reply(reply);
});

  return bot;
}
