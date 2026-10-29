services:
  - type: web
    name: discord-ticket-bot
    env: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: DISCORD_TOKEN
        sync: false
      - key: CLIENT_ID
        sync: false
      - key: GUILD_ID
        sync: false
      - key: BOT_PREFIX
        value: "!"

cronJobs:
  - name: ticket-bot-ping
    schedule: "*/15 * * * *"
    command: npm run ping
    env: node
    plan: free
