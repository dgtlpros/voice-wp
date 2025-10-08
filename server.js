// server.js
import http from "http";
import { WebSocketServer } from "ws";
import url from "url";

const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (twilioWS, req) => {
  const { query } = url.parse(req.url, true);
  console.log(
    "🔌 Twilio stream connected:",
    query.CallSid || query.callSid || "unknown"
  );

  twilioWS.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg.toString());
      if (evt.event === "start") console.log("▶️ start:", evt.start?.streamSid);
      else if (evt.event === "media")
        process.stdout.write("."); // audio frames flowing
      else if (evt.event === "stop")
        console.log("\n⏹️ stop:", evt.stop?.streamSid);
    } catch {
      /* ignore */
    }
  });

  twilioWS.on("close", () => console.log("\n🔌 Twilio stream closed"));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log("🎧 voice-ws listening on", PORT));
