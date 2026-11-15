# WhatsApp Bot source

This source bundle contains the WhatsApp web dashboard, the API server that hosts the linked-device bot, and the shared API packages used by both.

## WhatsApp commands

- `!msj <texto>` — set the message used by `!spam`. Send this from the linked account's private chat with itself. Text is limited to 250 characters and is saved locally.
- `!spam` — send the saved text with a changing emoji to the chat where the command is sent.
- `!ping` — check that the bot is active.
- `!ayuda` — show the command guide.

`CANT_SPAM` is read from Replit Secrets when the API starts. It accepts 1–20 messages, defaults to 5 if unset, schedules message starts 30 ms apart, and keeps a 60-second cooldown between batches. Change the secret and restart the API workflow to apply a new count.

## Run in the Replit workspace

1. Install dependencies with `pnpm install`.
2. Start the `artifacts/api-server: API Server` workflow.
3. Start the `artifacts/whatsapp-bot: web` workflow.
4. Pair WhatsApp with the QR, enable the bot, set the message with `!msj` in your self-chat, then run `!spam` in a chat you control.

The source ZIP intentionally excludes linked-device credentials, local bot settings, secret values, `node_modules`, and build output. Do not share the QR or the private dashboard link.
