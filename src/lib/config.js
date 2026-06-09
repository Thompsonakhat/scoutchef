export const cfg = { 
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        MONGODB_URI: process.env.MONGODB_URI || "",
        AI_TIMEOUT_MS: Number(process.env.AI_TIMEOUT_MS || 600000),

        // Optional: CookMyBots AI Gateway
        COOKMYBOTS_AI_ENDPOINT: process.env.COOKMYBOTS_AI_ENDPOINT || "",
        COOKMYBOTS_AI_KEY: process.env.COOKMYBOTS_AI_KEY || "",
        AI_DEBUG: String(process.env.AI_DEBUG || "0") === "1",
        AI_TIMEOUT_MS: Number(process.env.AI_TIMEOUT_MS || 20000),
        AI_MODEL: process.env.AI_MODEL || "",
        NATURAL_CHAT_MODE: String(process.env.NATURAL_CHAT_MODE || "1") === "1",
        NATURAL_CHAT_GROUP_REQUIRE_MENTION: String(process.env.NATURAL_CHAT_GROUP_REQUIRE_MENTION || "1") === "1",
        WEB3_CHAT_MODE: String(process.env.WEB3_CHAT_MODE || "auto"),

      };
