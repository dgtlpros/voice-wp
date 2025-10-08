// server.js
// Minimal Twilio <Stream> -> WS bridge with OpenAI Realtime (log-only)
// Requires: OPENAI_API_KEY set as a Fly secret

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import url from "url";

const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "⚠️  OPENAI_API_KEY not set. Run: flyctl secrets set OPENAI_API_KEY=sk-..."
  );
}

const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (twilioWS, req) => {
  const { query } = url.parse(req.url, true);
  const callSid = query.CallSid || query.callSid || "unknown";
  console.log("🔌 Twilio stream connected:", callSid);

  // 1) Connect to OpenAI Realtime (text/audio capable; we log text only for now)
  const oa = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      OPENAI_MODEL
    )}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  oa.on("open", () => {
    console.log("🧠 OpenAI Realtime connected");

    // Session config: concise receptionist, short answers, VAD for barge-in behavior
    oa.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio"],
          instructions:
            "You are a concise, friendly receptionist. Capture caller name and callback number early. " +
            "Prefer answers under 15 seconds. If unsure or a human is requested, say you will transfer.",
          voice: "verse",
          turn_detection: { type: "server_vad", silence_ms: 400 },
        },
      })
    );

    // Kick a greeting so we can see tokens come back in logs
    oa.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"], // we will route audio back to Twilio in the next step
          instructions: "Hi! Thanks for calling—how can I help today?",
        },
      })
    );
  });

  // 2) Log assistant text as it streams (proof we're receiving content)
  oa.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      // token stream
      if (evt.type === "response.output_text.delta" && evt.delta) {
        process.stdout.write(evt.delta);
      }
      if (evt.type === "response.completed") {
        process.stdout.write("\n🧠 response.completed\n");
      }

      // (For the next step) audio chunks would arrive as response.audio.delta, which we
      // will convert to μ-law 8kHz and send to Twilio as "media" events.
    } catch {
      // ignore non-JSON control frames
    }
  });

  oa.on("close", () => console.log("🧠 OpenAI Realtime closed"));
  oa.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));

  // 3) Handle Twilio Media Stream frames (start/media/stop) — log only for now
  twilioWS.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg.toString());
      if (evt.event === "start") {
        console.log("▶️  start:", evt.start?.streamSid);
      } else if (evt.event === "media") {
        // Twilio sends base64 μ-law (8kHz) audio in evt.media.payload
        // We'll forward this to OpenAI in the next step after transcoding to 16k PCM.
        process.stdout.write(".");
      } else if (evt.event === "mark") {
        console.log("\n📍 mark:", evt.mark?.name);
      } else if (evt.event === "stop") {
        console.log("\n⏹️  stop:", evt.stop?.streamSid);
      }
    } catch {
      // ignore non-JSON noise
    }
  });

  // Clean shutdown both sockets together
  const closeBoth = () => {
    try {
      twilioWS.close();
    } catch {}
    try {
      oa.close();
    } catch {}
  };

  twilioWS.on("close", () => {
    console.log("🔌 Twilio stream closed:", callSid);
    closeBoth();
  });
  twilioWS.on("error", (e) => {
    console.error("Twilio WS error:", e?.message || e);
    closeBoth();
  });
});

server.listen(PORT, () => console.log(`🎧 voice-ws listening on ${PORT}`));
