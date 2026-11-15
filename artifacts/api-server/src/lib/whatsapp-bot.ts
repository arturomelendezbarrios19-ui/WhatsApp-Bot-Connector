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

function readSavedBotSetting(): boolean {
  if (!existsSync(settingsFile)) return false;

  try {
    const saved = JSON.parse(readFileSync(settingsFile, "utf8")) as {
      botEnabled?: unknown;
    };
    return saved.botEnabled === true;
  } catch {
    return false;
  }
}

let botEnabled = readSavedBotSetting();
let currentSocket: ReturnType<typeof makeWASocket> | null = null;
let startInProgress: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
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
  const conversation = content?.["conversation"];
  const extendedText =
    textMessage && typeof textMessage === "object"
      ? (textMessage as Record<string, unknown>)["text"]
      : undefined;

  return typeof conversation === "string"
    ? conversation
    : typeof extendedText === "string"
      ? extendedText
      : "";
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
        jid.endsWith("@g.us") ||
        jid.endsWith("@newsletter")
      ) {
        continue;
      }

      const command = extractMessageText(message.message)
        .trim()
        .toLowerCase();
      if (command === "!ping") {
        await sock.sendMessage(jid, { text: "Bot activo." });
      } else if (command === "!ayuda") {
        await sock.sendMessage(jid, {
          text: "Comandos disponibles: !ping y !ayuda.",
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

  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ botEnabled: enabled }), {
    encoding: "utf8",
    mode: 0o600,
  });
  botEnabled = enabled;
  statusMessage = enabled
    ? "Bot activado. Usa !ping o !ayuda desde un chat individual."
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
