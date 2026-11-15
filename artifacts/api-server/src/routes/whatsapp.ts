import { Router, type IRouter } from "express";
import {
  ConnectWhatsappResponse,
  GetWhatsappStatusResponse,
  ToggleWhatsappBotBody,
  ToggleWhatsappBotResponse,
} from "@workspace/api-zod";
import {
  connectWhatsapp,
  getWhatsappStatus,
  setWhatsappBotEnabled,
} from "../lib/whatsapp-bot";

const router: IRouter = Router();

router.get("/whatsapp/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(GetWhatsappStatusResponse.parse(getWhatsappStatus()));
});

router.post("/whatsapp/connect", async (_req, res): Promise<void> => {
  const status = await connectWhatsapp();
  res.setHeader("Cache-Control", "no-store");
  res.json(ConnectWhatsappResponse.parse(status));
});

router.patch("/whatsapp/bot", async (req, res): Promise<void> => {
  const parsed = ToggleWhatsappBotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const status = await setWhatsappBotEnabled(parsed.data.enabled);
    res.setHeader("Cache-Control", "no-store");
    res.json(ToggleWhatsappBotResponse.parse(status));
  } catch (error) {
    if (error instanceof Error && error.message === "Conecta WhatsApp antes de activar el bot.") {
      res.status(409).json({ error: error.message });
      return;
    }

    throw error;
  }
});

export default router;
