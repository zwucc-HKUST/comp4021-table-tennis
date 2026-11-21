# Table Tennis Simulator

A first-person, two-player table tennis game for COMP 4021. The court is drawn with HTML Canvas, and a Node.js server uses Express and Socket.IO to host matches and sync play.

## Play

1. Open the same game URL on two computers, or use two browser tabs for a local test. Register or sign in with a different username for each player.
2. One player selects **Create a room** and shares the six-character code. The other enters it and selects **Join room**.
3. Move with **WASD** and press **Space** when it is your serve. The green ring predicts the first bounce. Line up early and the racket will return the ball automatically on contact after that bounce.

First to **5 points** wins. At the **3-minute** limit, the player with more points wins, with a draw if tied. Press **C** to toggle the optional golden-ball mode, which can change the ball's direction after it bounces on the opponent's side.

## Run locally

Install Node.js and run these commands in the repository folder.

```sh
npm ci
npm start
```

Open [http://localhost:8000](http://localhost:8000) in Chrome or Edge.

## Deploy on Render

Use a **Web Service** with build command `npm ci --omit=dev` and start command `npm start`. The server reads Render's `PORT` environment variable. Share the service's HTTPS URL with both players.
