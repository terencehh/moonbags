# Troubleshooting MoonBags

Start with the built-in checks. They are safe to run any time.

```bash
npm run doctor
```

In Telegram:

```text
/doctor
/setup_status
```

`/doctor` checks the live bot environment. `/setup_status` tells you what is still missing in plain English.

If `npm run doctor` is not available in your checkout yet, update the repo or use Telegram `/doctor` after the bot is running.

## Bot will not start

1. Confirm packages are installed:
   ```bash
   npm install
   ```
2. Confirm `.env` exists and was created by setup:
   ```bash
   npm run setup
   ```
3. Run the health check:
   ```bash
   npm run doctor
   ```
4. If running with `pm2`, restart with fresh environment variables:
   ```bash
   pm2 restart moonbags --update-env
   pm2 logs moonbags
   ```

## OKX OnchainOS not found

Install or update OnchainOS with the project command:

```bash
npm run install:onchainos
```

That runs OKX's official installer:

```bash
curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh
```

If `which onchainos` still prints nothing, add the usual install directory to PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Open a new terminal, then verify:

```bash
which onchainos
onchainos --version
onchainos token trending --help
```

If the bot runs under `pm2`, restart it after fixing PATH:

```bash
pm2 restart moonbags --update-env
```

## Telegram bot is quiet

1. Send `/start` to the bot.
2. Send `/doctor`.
3. Send `/setup_status`.
4. Confirm the bot is running:
   ```bash
   pm2 status
   pm2 logs moonbags
   ```
5. Restart if needed:
   ```bash
   pm2 restart moonbags --update-env
   ```

Only the chat ID in `.env` can control the bot. If you made a new Telegram bot or changed accounts, rerun setup.

## Update from Telegram

Use Telegram `/update` when the bot is already running under `pm2`.

`/update` checks incoming commits, refuses unsafe local changes, pulls `origin/main`, runs `npm install` when package files changed, and restarts `moonbags`.

If `/update` says `pm2` is missing:

```bash
npm install -g pm2
pm2 start "npm run start" --name moonbags
pm2 save
```

Then send `/update` again.

## Price or OnchainOS errors

If logs mention OKX, OnchainOS, `trending`, or price feed failures:

```bash
npm run install:onchainos
pm2 restart moonbags --update-env
```

Then run:

```bash
npm run doctor
```

Also check Telegram:

```text
/doctor
/setup_status
```

## Sell stuck

If Telegram reports `SELL STUCK`, try `/positions` and tap the sell button again. If it still fails, sell directly from your wallet.

Common causes are low SOL for fees, no liquidity, or a token that cannot be routed.

## After changing `.env`

Restart with updated environment:

```bash
pm2 restart moonbags --update-env
```

Then verify:

```text
/doctor
/setup_status
```
