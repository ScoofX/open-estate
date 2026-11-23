# Open Estate

Online Monopoly-style game for friends on separate devices.

- Server rolls all dice and shuffles cards with `crypto.randomInt`
- Every roll is public in the "Roll log" tab
- Rules enforced by the server (rent, houses, mortgages, jail, trades, bankruptcy)

## Run locally
    npm install
    npm start        # http://localhost:3000

## Deploy on Railway
Push these files to a repo, create a new Railway project from it. Railway runs `npm start` and sets PORT automatically. Open the generated domain, create a room, share the link.

Rooms live in memory, so a redeploy resets running games.
