const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { createMiniBank } = require("./mini-bank");
const miniBank = createMiniBank();

const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const Groq = require("groq-sdk");
const { GoogleGenAI } = require("@google/genai");

/**
 * Membaca dan memvalidasi konfigurasi environment.
 */
const config = {
  botPrefix: process.env.BOT_PREFIX || "!ai",
  sessionName: process.env.SESSION_NAME || "wa-ai-bot",

  defaultProvider: (process.env.DEFAULT_PROVIDER || "groq").toLowerCase(),
  defaultModel:
    process.env.DEFAULT_MODEL || "openai/gpt-oss-120b",

  temperature: Number.parseFloat(process.env.TEMPERATURE || "0.5"),
  maxTokens: Number.parseInt(process.env.MAX_TOKENS || "2048", 10),

  groqApiKey: process.env.GROQ_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,

  allowedUsers: (process.env.ALLOWED_USERS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
};

const AVAILABLE_MODELS = {
  groq: [
    "openai/gpt-oss-120b",
  ],
  gemini: [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
  ],
};

function validateConfig() {
  if (!["groq", "gemini"].includes(config.defaultProvider)) {
    throw new Error(
      `DEFAULT_PROVIDER tidak valid: ${config.defaultProvider}`
    );
  }

  if (!Number.isFinite(config.temperature)) {
    throw new Error("TEMPERATURE harus berupa angka.");
  }

  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    throw new Error("MAX_TOKENS harus berupa bilangan positif.");
  }

  if (!config.groqApiKey && !config.geminiApiKey) {
    console.warn("[AI] API key belum diisi. Menu dan Mini Bank tetap tersedia.");
  }
}

validateConfig();

/**
 * Inisialisasi provider hanya jika API key tersedia.
 */
const groq = config.groqApiKey
  ? new Groq({
      apiKey: config.groqApiKey,
    })
  : null;

const gemini = config.geminiApiKey
  ? new GoogleGenAI({
      apiKey: config.geminiApiKey,
    })
  : null;

/**
 * Konfigurasi aktif.
 *
 * Untuk versi awal, konfigurasi ini berlaku global.
 * Nantinya dapat dipindahkan ke database agar setiap user
 * mempunyai provider dan model sendiri.
 */
let activeProvider = config.defaultProvider;
let activeModel = ensureValidModel(activeProvider, config.defaultModel);

/**
 * Menentukan apakah pengirim diperbolehkan memakai bot.
 */
function isAllowedUser(message) {
  if (config.allowedUsers.length === 0) {
    return true;
  }

  return config.allowedUsers.includes(message.from);
}

/**
 * Mendapatkan model default berdasarkan provider.
 */
function getDefaultModel(provider) {
  const models = AVAILABLE_MODELS[provider];

  if (!models || models.length === 0) {
    throw new Error(`Tidak ada model yang dikonfigurasi untuk ${provider}.`);
  }

  return models[0];
}

/**
 * Memastikan model sesuai dengan provider.
 */
function ensureValidModel(provider, model) {
  const models = AVAILABLE_MODELS[provider] || [];

  if (!models.includes(model)) {
    return getDefaultModel(provider);
  }

  return model;
}

/**
 * Mengirim prompt ke Groq.
 */
async function askGroq(prompt, model) {
  if (!groq) {
    throw new Error("GROQ_API_KEY belum dikonfigurasi.");
  }

  const selectedModel = ensureValidModel("groq", model);

  const completion = await groq.chat.completions.create({
    model: selectedModel,
    temperature: config.temperature,
    max_completion_tokens: config.maxTokens,
    messages: [
      {
        role: "system",
        content:
          "Kamu adalah asisten pribadi melalui WhatsApp. " +
          "Jawab menggunakan Bahasa Indonesia yang jelas, akurat, " +
          "ringkas, dan mudah dipahami. Gunakan format yang nyaman " +
          "dibaca di WhatsApp.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const answer = completion.choices?.[0]?.message?.content?.trim();

  if (!answer) {
    throw new Error("Groq tidak memberikan jawaban.");
  }

  return {
    provider: "groq",
    model: selectedModel,
    text: answer,
  };
}

/**
 * Mengirim prompt ke Gemini.
 */
async function askGemini(prompt, model) {
  if (!gemini) {
    throw new Error("GEMINI_API_KEY belum dikonfigurasi.");
  }

  const selectedModel = ensureValidModel("gemini", model);

  const response = await gemini.models.generateContent({
    model: selectedModel,
    contents: prompt,
    config: {
      temperature: config.temperature,
      maxOutputTokens: config.maxTokens,
      systemInstruction:
        "Kamu adalah asisten pribadi melalui WhatsApp. " +
        "Jawab menggunakan Bahasa Indonesia yang jelas, akurat, " +
        "ringkas, dan mudah dipahami. Gunakan format yang nyaman " +
        "dibaca di WhatsApp.",
    },
  });

  const answer = response.text?.trim();

  if (!answer) {
    throw new Error("Gemini tidak memberikan jawaban.");
  }

  return {
    provider: "gemini",
    model: selectedModel,
    text: answer,
  };
}

/**
 * Mengirim prompt ke provider yang dipilih.
 */
async function askProvider(provider, prompt, model) {
  if (provider === "groq") {
    return askGroq(prompt, model);
  }

  if (provider === "gemini") {
    return askGemini(prompt, model);
  }

  throw new Error(`Provider tidak dikenal: ${provider}`);
}

/**
 * Memakai provider utama lalu fallback ke provider lain.
 */
async function askAI(prompt) {
  const primaryProvider = activeProvider;
  const fallbackProvider =
    primaryProvider === "groq" ? "gemini" : "groq";

  try {
    return await askProvider(primaryProvider, prompt, activeModel);
  } catch (primaryError) {
    console.error(
      `[AI] ${primaryProvider} gagal:`,
      primaryError.message
    );

    const fallbackAvailable =
      (fallbackProvider === "groq" && groq) ||
      (fallbackProvider === "gemini" && gemini);

    if (!fallbackAvailable) {
      throw primaryError;
    }

    console.log(`[AI] Mencoba fallback ke ${fallbackProvider}.`);

    return askProvider(
      fallbackProvider,
      prompt,
      getDefaultModel(fallbackProvider)
    );
  }
}

/**
 * Memecah jawaban panjang menjadi beberapa pesan.
 */
function splitMessage(text, maxLength = 3500) {
  if (text.length <= maxLength) {
    return [text];
  }

  const parts = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);

    if (splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }

    if (splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

/**
 * Mengirim jawaban dalam beberapa bagian bila terlalu panjang.
 */
async function sendLongReply(message, text) {
  const parts = splitMessage(text);

  for (const part of parts) {
    await message.reply(part);
  }
}

function getHelpText() {
  return [
    "🤖 *MENU UTAMA*", "",
    `1. ${config.botPrefix} <pertanyaan>`, "   Tanya asisten AI", "",
    "2. !mini bank", "   Catat dan cek keuangan", "",
    "3. !fitur", "   Fitur lainnya — segera hadir", "",
    "Pengaturan AI: !help ai",
  ].join("\n");
}

function getAIHelpText() {
  return [
    "*WhatsApp AI Bot*",
    "",
    `Kirim pertanyaan:`,
    `${config.botPrefix} jelaskan Docker secara sederhana`,
    "",
    "*Perintah:*",
    "!help",
    "Menampilkan bantuan.",
    "",
    "!provider",
    "Melihat provider aktif.",
    "",
    "!provider groq",
    "!provider gemini",
    "Mengganti provider.",
    "",
    "!model",
    "Melihat model aktif dan model yang tersedia.",
    "",
    "!model <nama-model>",
    "Mengganti model aktif.",
    "",
    "*Status saat ini:*",
    `Provider: ${activeProvider}`,
    `Model: ${activeModel}`,
  ].join("\n");
}

/**
 * Memproses command selain prompt AI.
 */
async function handleCommand(message) {
  const body = (message.body || "").trim();

  if (/^!help\s+ai$/i.test(body)) {
    await message.reply(getAIHelpText());
    return true;
  }

  if (body.toLowerCase() === "!fitur") {
    await message.reply("🚧 *FITUR LAINNYA*\nSegera hadir.\n\nMenu utama: !help");
    return true;
  }

  if (body.toLowerCase() === "!help") {
    await message.reply(getHelpText());
    return true;
  }

  if (body.toLowerCase() === "!provider") {
    await message.reply(
      [
        `Provider aktif: *${activeProvider}*`,
        "",
        "Provider tersedia:",
        "- groq",
        "- gemini",
        "",
        "Contoh:",
        "!provider gemini",
      ].join("\n")
    );

    return true;
  }

  if (body.toLowerCase().startsWith("!provider ")) {
    const requestedProvider = body
      .slice("!provider ".length)
      .trim()
      .toLowerCase();

    if (!["groq", "gemini"].includes(requestedProvider)) {
      await message.reply(
        "Provider tidak valid. Pilihan: groq atau gemini."
      );
      return true;
    }

    if (requestedProvider === "groq" && !groq) {
      await message.reply("GROQ_API_KEY belum dikonfigurasi.");
      return true;
    }

    if (requestedProvider === "gemini" && !gemini) {
      await message.reply("GEMINI_API_KEY belum dikonfigurasi.");
      return true;
    }

    activeProvider = requestedProvider;
    activeModel = getDefaultModel(requestedProvider);

    await message.reply(
      [
        `Provider diubah menjadi *${activeProvider}*.`,
        `Model aktif: *${activeModel}*.`,
      ].join("\n")
    );

    return true;
  }

  if (body.toLowerCase() === "!model") {
    const modelList = AVAILABLE_MODELS[activeProvider]
      .map((model) => `- ${model}`)
      .join("\n");

    await message.reply(
      [
        `Provider: *${activeProvider}*`,
        `Model aktif: *${activeModel}*`,
        "",
        "Model yang dikonfigurasi:",
        modelList,
        "",
        "Contoh:",
        `!model ${getDefaultModel(activeProvider)}`,
      ].join("\n")
    );

    return true;
  }

  if (body.toLowerCase().startsWith("!model ")) {
    const requestedModel = body.slice("!model ".length).trim();
    const availableModels = AVAILABLE_MODELS[activeProvider] || [];

    if (!availableModels.includes(requestedModel)) {
      await message.reply(
        [
          `Model tidak tersedia untuk ${activeProvider}.`,
          "",
          "Pilihan:",
          ...availableModels.map((model) => `- ${model}`),
        ].join("\n")
      );

      return true;
    }

    activeModel = requestedModel;

    await message.reply(
      `Model aktif diubah menjadi *${activeModel}*.`
    );

    return true;
  }

  return false;
}

/**
 * Inisialisasi WhatsApp.
 */
const chromeExecutablePath =
  process.env.CHROME_EXECUTABLE_PATH?.trim();

if (
  chromeExecutablePath &&
  !require("fs").existsSync(chromeExecutablePath)
) {
  throw new Error(
    `Chrome tidak ditemukan pada path: ${chromeExecutablePath}`
  );
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: config.sessionName,
  }),
  puppeteer: {
    headless: true,
    executablePath: chromeExecutablePath || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

client.on("qr", (qr) => {
  console.log("Scan QR berikut melalui WhatsApp > Perangkat tertaut:");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("[WhatsApp] Autentikasi berhasil.");
});

client.on("ready", () => {
  console.log("[WhatsApp] Bot siap digunakan.");
  console.log(`[AI] Provider aktif: ${activeProvider}`);
  console.log(`[AI] Model aktif: ${activeModel}`);
});

client.on("auth_failure", (error) => {
  console.error("[WhatsApp] Autentikasi gagal:", error);
});

client.on("disconnected", (reason) => {
  console.error("[WhatsApp] Terputus:", reason);
});

client.on("message", async (message) => {
  try {
    if (message.fromMe) {
      return;
    }

    if (!isAllowedUser(message)) {
      console.warn(`[Security] Pesan ditolak dari ${message.from}`);
      return;
    }

    // Abaikan status dan broadcast.
    if (
      message.from === "status@broadcast" ||
      message.from.endsWith("@broadcast")
    ) {
      return;
    }

    // Finance commands never go to an AI provider.
    if (await miniBank.handle(message)) {
      return;
    }

    const commandHandled = await handleCommand(message);

    if (commandHandled) {
      return;
    }

    const prefix = config.botPrefix;
    const body = (message.body || "").trim();

    if (!body.toLowerCase().startsWith(prefix.toLowerCase())) {
      return;
    }

    const prompt = body.slice(prefix.length).trim();

    if (!prompt) {
      await message.reply(
        `Tuliskan pertanyaan setelah ${prefix}.\n\n` +
          `Contoh:\n${prefix} jelaskan apa itu REST API`
      );
      return;
    }

    console.log(
      `[Message] Pertanyaan diterima dari ${message.from}`
    );

    const result = await askAI(prompt);

    const responseText = [
      result.text,
      "",
      `_Provider: ${result.provider} | Model: ${result.model}_`,
    ].join("\n");

    await sendLongReply(message, responseText);
  } catch (error) {
    console.error("[Bot] Error:", error);

    try {
      await message.reply(
        "Maaf, terjadi kesalahan saat memproses permintaan.\n" +
          "Silakan periksa terminal untuk detail error."
      );
    } catch (replyError) {
      console.error(
        "[Bot] Gagal mengirim pesan error:",
        replyError
      );
    }
  }
});

process.on("unhandledRejection", (error) => {
  console.error("[Process] Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("[Process] Uncaught exception:", error);
});

console.log("[System] Memulai WhatsApp AI Bot...");
client.initialize();