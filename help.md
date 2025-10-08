Here you go — drop this into a `README.md` in your repos.

---

# AI Voice MVP — Current Setup

## Overview

You’ve built an AI-ready phone system that:

- answers a Twilio number,
- streams live audio to your WebSocket service,
- records each call, transcribes it with Whisper,
- saves transcript + summary to Supabase.

## High-Level Flow

```
Caller → Twilio Number
  │
  ├─(POST)→ Vercel /api/voice/inbound  ── returns TwiML:
  │           <Connect><Stream url="wss://voice-ws.../ws?callSid=...">
  │
  ├─ Twilio opens WS → Fly.io voice-ws (audio frames flow)
  │         (voice-ws currently logs media frames — no AI reply yet)
  │
  └─ Twilio recording (started from inbound handler)
       └─(POST when ready)→ Vercel /api/voice/recording
             ↳ fetch .mp3 (Twilio) → Whisper (OpenAI) → Supabase row
```

---

## Repos

### `ai-voice-app` (Next.js on Vercel)

- Webhooks, recording/transcription, Supabase writes.
- Endpoints:

  - `POST /api/voice/inbound` — returns TwiML `<Connect><Stream>` and starts recording.
  - `POST /api/voice/recording` — transcribes and stores results.

**Key files**

```ts
// app/api/voice/inbound/route.ts (abridged)
import twilio from "twilio";
import { NextResponse } from "next/server";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const raw = await req.text();
  const p = new URLSearchParams(raw);
  const callSid = p.get("CallSid") || "";
  const vr = new twilio.twiml.VoiceResponse();

  vr.say("Connecting you now.");
  const connect = vr.connect();
  connect.stream({
    url: `${process.env.VOICE_WS_URL}?callSid=${encodeURIComponent(callSid)}`,
  });

  // start full-call recording so the recording webhook fires
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_AUTH_TOKEN!
  );
  client
    .calls(callSid)
    .recordings.create({
      recordingStatusCallback: `${process.env.NEXT_PUBLIC_BASE_URL}/api/voice/recording`,
      recordingStatusCallbackEvent: ["completed"],
    })
    .catch(() => {});

  return new NextResponse(vr.toString(), {
    headers: { "Content-Type": "text/xml" },
  });
}
```

```ts
// app/api/voice/recording/route.ts (abridged)
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const raw = await req.text();
  const p = new URLSearchParams(raw);
  const recordingUrl = p.get("RecordingUrl");
  const callSid = p.get("CallSid");
  const from = p.get("From");
  const to = p.get("To");
  const duration = Number(p.get("RecordingDuration") || 0);

  // Fetch MP3 from Twilio (Basic Auth)
  const mediaUrl = `${recordingUrl}.mp3`;
  const twilioRes = await fetch(mediaUrl, {
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString("base64"),
    },
  });
  const audio = await twilioRes.arrayBuffer();

  // Whisper transcription
  const file = new File([new Uint8Array(audio)], "recording.mp3", {
    type: "audio/mpeg",
  });
  const form = new FormData();
  form.append("file", file);
  form.append("model", "whisper-1");
  const wRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!}` },
    body: form,
  });
  const wData = await wRes.json();
  const transcript = wData?.text || "";

  // Optional: short summary (gpt-4o-mini)
  const sRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Summarize the call in 1–2 sentences with intent and next step.",
        },
        { role: "user", content: transcript.slice(0, 12000) },
      ],
      temperature: 0.2,
    }),
  });
  const summary =
    (await sRes.json())?.choices?.[0]?.message?.content?.trim() || "";

  // Save to Supabase
  await supabaseAdmin.from("calls").insert({
    call_sid: callSid,
    from_number: from,
    to_number: to,
    duration_seconds: duration,
    recording_url: mediaUrl,
    transcript,
    summary,
  });

  return NextResponse.json({ ok: true });
}
```

**Supabase helper**

```ts
// lib/supabaseAdmin.ts
import { createClient } from "@supabase/supabase-js";
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);
```

**DB schema**

```sql
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  call_sid text unique,
  from_number text,
  to_number text,
  duration_seconds int,
  recording_url text,
  transcript text,
  summary text,
  created_at timestamptz default now()
);
alter table calls disable row level security;
```

**Vercel env**

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_NUMBER=+1...
FORWARD_TO=+1...
NEXT_PUBLIC_BASE_URL=https://your-app.vercel.app
OPENAI_API_KEY=sk-...
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
VOICE_WS_URL=wss://voice-ws-<name>.fly.dev/ws
```

---

### `voice-ws` (WebSocket service on Fly.io)

- Receives Twilio Media Streams (`start`, `media`, `stop`).
- Currently logs frames (`.`). Next step is bridging to OpenAI Realtime.

**server.js**

```js
import http from "http";
import { WebSocketServer } from "ws";
import url from "url";

const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (twilioWS, req) => {
  const { query } = url.parse(req.url, true);
  const callSid = query.CallSid || query.callSid || "unknown";
  console.log("🔌 Twilio stream connected:", callSid);

  twilioWS.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg.toString());
      if (evt.event === "start") console.log("▶️ start:", evt.start?.streamSid);
      else if (evt.event === "media") process.stdout.write(".");
      else if (evt.event === "stop")
        console.log("\n⏹️ stop:", evt.stop?.streamSid);
    } catch {}
  });

  twilioWS.on("close", () =>
    console.log("\n🔌 Twilio stream closed:", callSid)
  );
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("🎧 voice-ws listening on", PORT));
```

**fly.toml (important bits)**

```toml
app = "voice-ws-<yourname>"
primary_region = "sjc"

[http_service]
  internal_port = 3000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "off"
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "256mb"
```

**Dockerfile** (if you use one)

- Ensure server listens on the same port you expose (`3000`).

---

## Twilio Console Settings

**Phone Numbers → Your Number → Voice & Fax**

- **A Call Comes In**: Webhook → `POST https://<your-vercel-app>.vercel.app/api/voice/inbound`
- (Optional) **Primary handler fails**: TwiML Bin that says “We’re having trouble—please try again later.”
- Trial mode: only verified numbers can call/receive; you’ll hear a “trial” notice.

---

## Testing

### Webhook sanity (no phone)

```bash
# Windows (PowerShell)
curl.exe -X POST "https://<your-vercel-app>.vercel.app/api/voice/inbound" -H "Content-Type: application/x-www-form-urlencoded" --data "To=%2B1208...&From=%2B1208..."
```

Expect TwiML XML response with `<Connect><Stream>…`.

### Live call path

1. Call your Twilio number.
2. **Fly logs**: `flyctl logs` → see `start`, dots `.....`, `stop`.
3. **Vercel logs**: after hangup, see “Received recording…” and “Transcript saved”.
4. **Supabase**: row appears in `calls` table (transcript + summary).

---

## Common Issues & Fixes

- **405 on /inbound in browser** → route expects `POST` (add a `GET` handler for a simple “OK” check).
- **Twilio says “application error”** → parse form with `await req.text()` + `URLSearchParams`, set `export const runtime="nodejs"`.
- **Whisper 429 insufficient_quota** → add OpenAI API billing/credits, then redeploy.
- **Recording URL asks for username/password** → Twilio media requires Basic Auth (handled server-side already).
- **Fly no response** → port mismatch; ensure `server.js` and `fly.toml` both use `3000`.

---

## Costs (ballpark)

- Twilio voice: ~$0.0085/min
- Twilio recording: ~$0.0025/min
- Whisper transcription: ~$0.006/min
- Fly.io WS: ~$2–$3/mo (shared-cpu-1x, 256–512 MB)
- Vercel/Supabase: small shared costs; free tiers available

Keep AI replies concise + transfer quickly to control minutes.

---

## Next Milestone (Step 6C)

- In `voice-ws`, bridge Twilio audio ↔ OpenAI Realtime:

  - send Twilio media frames to OpenAI,
  - send OpenAI’s audio back as Twilio `media` frames (μ-law 8kHz, base64),
  - add session config: concise style, barge-in, max 90s agent talk, transfer triggers.

When ready, we’ll paste the minimal bridge code to make the bot **talk back** in realtime.
