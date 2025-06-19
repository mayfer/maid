import { exec, spawn } from "child_process";
import WebSocket, { WebSocketServer } from "ws";

// Configuration
const TMUX_SESSION = "claude_session";
const TMUX_TARGET = `${TMUX_SESSION}:0.0`;
const POLL_INTERVAL = 1000; // Update every 1 second

// Start tmux session and run "claude"
function startTmuxSession() {
  // Kill existing session (if any) and start a new one
  exec(`tmux kill-session -t ${TMUX_SESSION} || true`, () => {
    exec(`tmux new-session -d -s ${TMUX_SESSION}`, (err) => {
      if (err) {
        console.error("Failed to start tmux session:", err);
        return;
      }
      // Send "claude" command to the session
      exec(`tmux send-keys -t ${TMUX_TARGET} "claude" Enter`, (err) => {
        if (err) console.error("Failed to run claude:", err);
      });
    });
  });
}

// Capture tmux pane content
function captureTmuxPane(callback) {
  exec(`tmux capture-pane -t ${TMUX_TARGET} -p`, (err, stdout) => {
    if (err) {
      console.error("Error capturing pane:", err);
      callback("");
      return;
    }
    callback(stdout);
  });
}

// WebSocket server
const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws) => {
  console.log("Browser client connected");

  // Send initial state
  captureTmuxPane((content) => ws.send(content));

  // Poll tmux pane and send updates
  const interval = setInterval(() => {
    captureTmuxPane((content) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(content);
      }
    });
  }, POLL_INTERVAL);

  ws.on("close", () => {
    console.log("Browser client disconnected");
    clearInterval(interval);
  });

  ws.on("error", (err) => console.error("WebSocket error:", err));
});

// Start the tmux session when the server starts
startTmuxSession();

console.log("WebSocket server running on ws://localhost:8080");