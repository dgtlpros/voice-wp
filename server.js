// server.js
// Twilio <Connect><Stream> bridge with OpenAI Realtime (audio-out enabled)
// Requires: OPENAI_API_KEY set on Fly (flyctl secrets set OPENAI_API_KEY=sk-...)

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import url from "url";

// ---- Config
const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const PORT = process.env.PORT || 3000;

// ---- μ-law encode helpers (G.711) + simple resampling 24k → 8k
function pcm16ToMuLawByte(sample) {
  // Clamp
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;

  const BIAS = 0x84; // 132
  const CLIP = 32635;

  let sign = (sample >> 8) & 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;

  // Compute exponent
  let exponent = 7;
  for (
    let expMask = 0x4000;
    (sample & expMask) === 0 && exponent > 0;
    expMask >>= 1
  ) {
    exponent--;
  }
  const mantissa = (sample >> ((exponent > 0 ? exponent : 0) + 3)) & 0x0f;
  let ulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return ulaw;
}

function downsample24kTo8k(pcm16LE) {
  // Naive 3:1 decimation (good enough for MVP)
  const out = new Int16Array(Math.floor(pcm16LE.length / 3));
  for (let i = 0, j = 0; j < out.length; i += 3, j++) out[j] = pcm16LE[i];
  return out;
}

function pcm16ToMuLawBytes(pcm16LE) {
  const out = new Uint8Array(pcm16LE.length);
  for (let i = 0; i < pcm16LE.length; i++)
    out[i] = pcm16ToMuLawByte(pcm16LE[i]);
  return out;
}

function base64PCM16ToInt16Array(b64) {
  const buf = Buffer.from(b64, "base64");
  // Node Buffer → Int16Array view (LE)
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
}

function sendMuLawToTwilio(twilioWS, streamSid, muBytes) {
  // Chunk into ~20ms frames: 8kHz * 0.02s = 160 samples (160 bytes μ-law)
  const CHUNK = 160;
  for (let off = 0; off < muBytes.length; off += CHUNK) {
    const slice = muBytes.subarray(off, Math.min(off + CHUNK, muBytes.length));
    const payloadB64 = Buffer.from(slice).toString("base64");
    twilioWS.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: payloadB64 },
      })
    );
  }
}

// ---- Server
const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (twilioWS, req) => {
  const { query } = url.parse(req.url, true);
  const callSid = query.CallSid || query.callSid || "unknown";
  console.log("🔌 Twilio stream connected:", callSid);

  let streamSid = null;

  // 1) Open OpenAI Realtime WS
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

    // Session config (concise receptionist)
    oa.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio"],
          instructions:
            "You are a concise, friendly receptionist. Capture the caller's name and callback number early. " +
            "Keep answers under 15 seconds. If unsure or a human is requested, say you will transfer.",
          voice: "verse",
          turn_detection: { type: "server_vad", silence_ms: 400 },
        },
      })
    );

    // Kick greeting so we can hear audio out
    oa.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: "Hi! Thanks for calling—how can I help today?",
        },
      })
    );
  });

  // 2) Handle OpenAI → Twilio audio
  oa.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      // Text logs (nice to see)
      if (evt.type === "response.output_text.delta" && evt.delta) {
        process.stdout.write(evt.delta);
      }
      if (evt.type === "response.completed") {
        process.stdout.write("\n🧠 response.completed\n");
      }

      // AUDIO OUT: Some SDKs emit "response.output_audio.delta"; others "response.audio.delta"
      const audioB64 =
        (evt.type === "response.output_audio.delta" && evt.delta) ||
        (evt.type === "response.audio.delta" && evt.audio);

      if (audioB64 && streamSid) {
        // evt.<delta|audio> is base64 PCM16 @ 24kHz (mono)
        const pcm24k = base64PCM16ToInt16Array(audioB64);
        const pcm8k = downsample24kTo8k(pcm24k);
        const mu = pcm16ToMuLawBytes(pcm8k);
        sendMuLawToTwilio(twilioWS, streamSid, mu);
      }
    } catch {
      // ignore non-JSON frames
    }
  });

  oa.on("close", () => console.log("🧠 OpenAI Realtime closed"));
  oa.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));

  // 3) Twilio Media stream (capture streamSid; still logging caller media)
  twilioWS.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg.toString());
      if (evt.event === "start") {
        streamSid = evt.start?.streamSid;
        console.log("▶️  start:", streamSid);
      } else if (evt.event === "media") {
        process.stdout.write(".");
        // (Next step we’ll forward caller audio into OpenAI)
      } else if (evt.event === "stop") {
        console.log("\n⏹️  stop:", evt.stop?.streamSid);
        try {
          oa.close();
        } catch {}
      }
    } catch {}
  });

  // Clean up
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
