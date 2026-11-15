import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

export type WhatsappConnectionState =
  | "idle"
  | "connecting"
  | "waiting_qr"
  | "connected"
  | "reconnecting"
  | "error";

export interface WhatsappStatus {
  connectionState: WhatsappConnectionState;
  connected: boolean;
  botEnabled: boolean;
  phoneNumber: string | null;
  qrDataUrl: string | null;
  statusMessage: string;
}

const sessionDir = path.resolve(
  process.env["WHATSAPP_SESSION_DIR"] ?? path.join(process.cwd(), ".whatsapp-auth"),
);
const settingsFile = path.resolve(
  process.env["WHATSAPP_SETTINGS_FILE"] ??
    path.join(process.cwd(), ".whatsapp-bot-settings.json"),
);
const logger = pino({ level: "silent" });
function getSpamCount(): number {
  const value = process.env["CANT_SPAM"]?.trim();
  if (!value || !/^\d+$/.test(value)) return 5;
  return Math.max(1, Math.min(20, Number(value)));
}

const spamCount = getSpamCount();
const spamIntervalMs = 30;
const spamCooldownMs = 60_000;
const maxSpamTextLength = 250;
const spamEmojis = ["🥵", "👹", "👺", "🤖", "☠️", "💀"];

interface SavedBotSettings {
  botEnabled: boolean;
  spamText: string;
}

function readSavedBotSettings(): SavedBotSettings {
  if (!existsSync(settingsFile)) return { botEnabled: false, spamText: "XD" };

  try {
    const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as {
      botEnabled?: unknown;
      spamText?: unknown;
    };
    return {
      botEnabled: saved.botEnabled === true,
      spamText:
        typeof saved.spamText === "string" && saved.spamText.trim()
          ? saved.spamText.trim().slice(0, maxSpamTextLength)
          : "XD",
    };
  } catch {
    return { botEnabled: false, spamText: "XD" };
  }
}

const savedSettings = readSavedBotSettings();
let botEnabled = savedSettings.botEnabled;
let spamText = savedSettings.spamText;

async function saveBotSettings(): Promise<void> {
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ botEnabled, spamText }), {
    encoding: "utf8",
    mode: 0o600,
  });
}

let currentSocket: ReturnType<typeof makeWASocket> | null = null;
let startInProgress: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let spamRunning = false;
let spamCooldownUntil = 0;
let connectionState: WhatsappConnectionState = "idle";
let phoneNumber: string | null = null;
let qrDataUrl: string | null = null;
let statusMessage = "Conecta tu cuenta de WhatsApp para comenzar.";

function getStatus(): WhatsappStatus {
  return {
    connectionState,
    connected: connectionState === "connected",
    botEnabled,
    phoneNumber,
    qrDataUrl,
    statusMessage,
  };
}

function numberFromJid(jid?: string | null): string | null {
  if (!jid) return null;
  const number = jid.split("@")[0]?.split(":")[0]?.replace(/\D/g, "");
  return number || null;
}

function isOwnPrivateChat(
  sock: ReturnType<typeof makeWASocket>,
  jid: string,
): boolean {
  const ownJid = sock.user?.id;
  const ownNumber = numberFromJid(ownJid);
  return (
    jid.endsWith("@s.whatsapp.net") &&
    Boolean(ownNumber) &&
    numberFromJid(jid) === ownNumber
  );
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const ephemeral = record["ephemeralMessage"];
  const content =
    ephemeral && typeof ephemeral === "object"
      ? ((ephemeral as Record<string, unknown>)["message"] as
          | Record<string, unknown>
          | undefined)
      : record;
  const textMessage = content?.["extendedTextMessage"];
  const imageMessage = content?.["imageMessage"];
  const videoMessage = content?.["videoMessage"];
  const conversation = content?.["conversation"];
  const extendedText =
    textMessage && typeof textMessage === "object"
      ? (textMessage as Record<string, unknown>)["text"]
      : undefined;
  const imageCaption =
    imageMessage && typeof imageMessage === "object"
      ? (imageMessage as Record<string, unknown>)["caption"]
      : undefined;
  const videoCaption =
    videoMessage && typeof videoMessage === "object"
      ? (videoMessage as Record<string, unknown>)["caption"]
      : undefined;

  return [conversation, extendedText, imageCaption, videoCaption].find(
    (value): value is string => typeof value === "string",
  ) ?? "";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runSpamTest(
  sock: ReturnType<typeof makeWASocket>,
  jid: string,
): Promise<void> {
  if (spamRunning) {
    await sock.sendMessage(jid, {
      text: "Ya hay un envío en curso. Espera a que termine.",
    });
    return;
  }

  const now = Date.now();
  if (now < spamCooldownUntil) {
    const secondsLeft = Math.ceil((spamCooldownUntil - now) / 1000);
    await sock.sendMessage(jid, {
      text: `Espera ${secondsLeft} s antes de volver a usar !spam.`,
    });
    return;
  }

  spamRunning = true;
  spamCooldownUntil = now + spamCooldownMs;
  const messageForBatch = spamText;

  try {
    const jobs = Array.from({ length: spamCount }, async (_, index) => {
      // Each message begins 30 ms after the previous start,
      // without waiting for WhatsApp to acknowledge the earlier send.
      if (index > 0) await sleep(index * spamIntervalMs);
      const emoji = spamEmojis[index % spamEmojis.length]!;
      const text = `${messageForBatch} ${emoji}`;
      await sock.sendMessage(jid, { text });
    });

    const results = await Promise.allSettled(jobs);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      await sock.sendMessage(jid, {
        text: `No se pudieron enviar ${failed} mensajes. Revisa la conexión de WhatsApp.`,
      });
    }
  } finally {
    spamRunning = false;
  }
}

function handleIncomingMessages(sock: ReturnType<typeof makeWASocket>): void {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (!botEnabled || type !== "notify") return;

    for (const message of messages) {
      const jid = message.key.remoteJid;
      if (
        !message.key.fromMe ||
        !jid ||
        jid === "status@broadcast" ||
        jid.endsWith("@newsletter")
      ) {
        continue;
      }

      const timestamp = Number(message.messageTimestamp);
      if (timestamp && Date.now() / 1000 - timestamp > 60) continue;

      const messageText = extractMessageText(message.message).trim();
      const commandName = messageText.split(/\s+/)[0]?.toLowerCase();
      if (commandName === "!spam") {
        await runSpamTest(sock, jid);
      } else if (commandName === "!ping") {
        await sock.sendMessage(jid, { text: "Bot activo." });
      } else if (commandName === "!ayuda") {
        await sock.sendMessage(jid, {
          text:
            "Comandos: !ping, !ayuda, !msj texto y !spam. " +
            "Configura !msj texto en tu chat contigo mismo; después usa !spam en el chat elegido. " +
            "Envía la cantidad configurada (1–20) con tu texto y emojis, 30 ms entre inicios y cooldown de 60 s.",
        });
      } else if (commandName === "!msj" && isOwnPrivateChat(sock, jid)) {
        const nextSpamText = messageText.slice("!msj".length).trim().replace(/\s+/g, " ");
        if (!nextSpamText) {
          await sock.sendMessage(jid, {
            text: `Uso: !msj texto\nTexto actual: ${spamText}`,
          });
          continue;
        }
        if (nextSpamText.length > maxSpamTextLength) {
          await sock.sendMessage(jid, {
            text: `El texto puede tener hasta ${maxSpamTextLength} caracteres.`,
          });
          continue;
        }

        const previousSpamText = spamText;
        spamText = nextSpamText;
        try {
          await saveBotSettings();
        } catch (error) {
          spamText = previousSpamText;
          logger.error({ err: error }, "Could not save the WhatsApp spam message");
          await sock.sendMessage(jid, {
            text: "No pude guardar el texto. Inténtalo de nuevo.",
          });
          continue;
        }
        await sock.sendMessage(jid, {
          text: `Texto de !spam actualizado: ${spamText}`,
        });
      }
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  if (reconnectAttempts >= 8) {
    connectionState = "error";
    statusMessage =
      "No se pudo restablecer la conexión. Vuelve a intentarlo desde el panel.";
    return;
  }

  const delay = Math.min(30_000, 1_500 * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  connectionState = "reconnecting";
  statusMessage = "Conexión interrumpida. Intentando reconectar…";
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startWhatsappConnection();
  }, delay);
}

async function startWhatsappConnection(): Promise<void> {
  if (startInProgress) return startInProgress;
  if (connectionState === "connected" || connectionState === "waiting_qr") return;

  connectionState = "connecting";
  qrDataUrl = null;
  statusMessage = "Preparando la conexión segura con WhatsApp…";

  startInProgress = (async () => {
    try {
      await mkdir(sessionDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      let version: [number, number, number] | undefined;

      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch (error) {
        logger.warn({ err: error }, "Could not fetch the latest WhatsApp Web version");
      }

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });
      currentSocket = sock;
      sock.ev.on("creds.update", saveCreds);
      handleIncomingMessages(sock);

      sock.ev.on("connection.update", (update) => {
        if (sock !== currentSocket) return;

        if (update.qr) {
          connectionState = "waiting_qr";
          statusMessage =
            "Abre WhatsApp en tu teléfono y escanea el código para vincularlo.";
          void QRCode.toDataURL(update.qr, { margin: 1, width: 300 })
            .then((dataUrl) => {
              if (sock === currentSocket) qrDataUrl = dataUrl;
            })
            .catch((error: unknown) => {
              logger.error({ err: error }, "Could not render WhatsApp QR code");
              connectionState = "error";
              statusMessage = "No se pudo generar el código QR. Vuelve a intentarlo.";
            });
        }

        if (update.connection === "open") {
          reconnectAttempts = 0;
          connectionState = "connected";
          phoneNumber = numberFromJid(sock.user?.id);
          qrDataUrl = null;
          statusMessage = "WhatsApp está conectado.";
        }

        if (update.connection === "close") {
          currentSocket = null;
          qrDataUrl = null;
          const error = update.lastDisconnect?.error as
            | { output?: { statusCode?: number } }
            | undefined;
          const code = error?.output?.statusCode;

          if (code === DisconnectReason.loggedOut) {
            connectionState = "idle";
            phoneNumber = null;
            statusMessage =
              "La sesión se cerró desde WhatsApp. Vuelve a conectar para vincularla.";
            void rm(sessionDir, { recursive: true, force: true });
            return;
          }

          if (
            code === DisconnectReason.connectionReplaced ||
            code === DisconnectReason.forbidden
          ) {
            connectionState = "error";
            statusMessage =
              code === DisconnectReason.connectionReplaced
                ? "Esta cuenta ya tiene otra sesión del bot conectada."
                : "WhatsApp rechazó la conexión. Espera un momento y vuelve a intentarlo.";
            return;
          }

          scheduleReconnect();
        }
      });
    } catch (error) {
      logger.error({ err: error }, "Could not start WhatsApp connection");
      scheduleReconnect();
    } finally {
      startInProgress = null;
    }
  })();

  return startInProgress;
}

export async function connectWhatsapp(): Promise<WhatsappStatus> {
  await startWhatsappConnection();
  return getStatus();
}

export async function setWhatsappBotEnabled(enabled: boolean): Promise<WhatsappStatus> {
  if (enabled && connectionState !== "connected") {
    throw new Error("Conecta WhatsApp antes de activar el bot.");
  }

  const previousBotEnabled = botEnabled;
  botEnabled = enabled;
  try {
    await saveBotSettings();
  } catch (error) {
    botEnabled = previousBotEnabled;
    throw error;
  }
  statusMessage = enabled
    ? "Bot activado. Configura !msj texto en tu chat contigo mismo y usa !spam en el chat elegido. CANT_SPAM limita la cantidad a 1–20."
    : connectionState === "connected"
      ? "Bot en pausa. WhatsApp permanece conectado."
      : "Bot en pausa.";

  return getStatus();
}

export function getWhatsappStatus(): WhatsappStatus {
  return getStatus();
}

export function stopWhatsappConnection(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const socket = currentSocket;
  currentSocket = null;
  connectionState = "idle";
  qrDataUrl = null;
  phoneNumber = null;
  statusMessage = "Conecta tu cuenta de WhatsApp para comenzar.";
  if (socket) void socket.end(undefined);
}
