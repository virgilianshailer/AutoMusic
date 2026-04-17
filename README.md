# 🎵 AutoMusic

> AI-powered ambient sound & background music generation for SillyTavern, driven by ComfyUI.

AutoMusic reads your chat context, asks the LLM to analyse the scene, then generates matching **ambient sounds** (via Stable Audio) and **background music** (via ACE Step) through your local ComfyUI instance — all automatically, with crossfade transitions and a persistent per-chat library.

---

## Features

- **Automatic scene analysis** — after each message (or every N messages) the LLM reads recent chat history and decides whether the ambient/music should change
- **Dual audio streams** — separate channels for environmental ambient sounds and background music, each with independent volume, mute, and lock controls
- **Two ComfyUI models out of the box**
  - 🔊 **Stable Audio** — for atmospheric/environmental sounds
  - 🎵 **ACE Step v1.5** — for full music generation with BPM, key, and time signature control
- **LLM-driven music parameters** — optionally let the model pick BPM, key scale, and time signature to match the scene mood
- **Crossfade transitions** — smooth fade between tracks when the scene changes
- **Persistent audio library** — generated tracks are saved per-chat and survive page reloads; supports shuffle and auto-play-next
- **Session gallery** — quick in-session overview of everything generated this session with playback and download
- **Music presets** — save/load UNET model + generation parameter sets for fast switching
- **UNET model picker** — fetch available models directly from your ComfyUI instance
- **Custom workflows** — supply your own ComfyUI workflow JSON for full control; template variables supported
- **Auto-delete on chat removal** — optionally clean up saved track files when a chat or group is deleted

---

## Requirements

| Requirement | Notes |
|---|---|
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) | Latest stable recommended |
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) | Must be running and accessible |
| **Stable Audio Open 1.0** | For ambient generation — `stable-audio-open-1.0.safetensors` |
| **ACE Step v1.5 XL** | For music generation — `acestep_v1.5_xl_sft_bf16.safetensors` |
| `SaveAudioMP3` ComfyUI node | Part of [ComfyUI-AudioScheduler](https://github.com/a1lazydog/ComfyUI-AudioScheduler) or similar |

---

## Installation

1. Open SillyTavern → **Extensions** → **Install Extension**
2. Paste the URL of this repository and click Install
3. Reload the page — the **🎵 AutoMusic** panel will appear in the Extensions sidebar

Or install manually:

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/virgilianshailer/AutoMusic
```

---

## Setup

1. Make sure ComfyUI is running (default: `http://127.0.0.1:8188`)
2. Open the **AutoMusic** panel in SillyTavern's extension settings
3. Expand **⚙️ Advanced Settings** and set your **ComfyUI URL** if it differs from the default
4. Click **🧪 Test** to verify the connection — you'll see the current queue status
5. Click **🔄** next to the UNET Model field to load available models from ComfyUI
6. Enable the extension with the **Enabled** checkbox
7. Start or continue a chat — music will generate automatically after the configured start delay

---

## Settings Reference

### General toggles

| Setting | Description |
|---|---|
| **Enabled** | Master on/off switch |
| **Ambient sounds** | Enable/disable ambient channel (Stable Audio) |
| **Background music** | Enable/disable music channel (ACE Step) |
| **Generate on chat start** | Trigger generation when a chat is opened |
| **LLM picks BPM / key / time sig** | Let the model choose music theory parameters |
| **Session gallery** | Show the in-session track gallery button |
| **Save to library** | Persist generated tracks to disk per-chat |
| **Library: Shuffle** | Randomise playback order from the library |
| **Library: Auto-play next on end** | Automatically play the next library track when one ends |
| **Auto-delete tracks on chat removal** | Delete saved audio files when the chat/group is deleted |
| **Analyze every N message(s)** | Check for scene changes only every N messages (reduces LLM calls) |

### Ambient (Stable Audio)

| Setting | Default | Description |
|---|---|---|
| Duration | 60 s | Length of generated ambient clip |
| Steps | 50 | Sampler steps (quality vs speed) |
| CFG | 5 | Classifier-free guidance scale |
| Loop | ✓ | Loop the clip continuously |
| Custom workflow JSON | — | Override the built-in workflow |

### Music (ACE Step)

| Setting | Default | Description |
|---|---|---|
| Duration | 120 s | Length of generated music clip |
| Steps | 8 | Sampler steps |
| CFG | 1 | Guidance scale |
| UNET Model | `acestep_v1.5_xl_sft_bf16.safetensors` | Model file name |
| Loop | ✓ | Loop the clip continuously |
| Custom workflow JSON | — | Override the built-in workflow; must contain `%unet_name%` |

### General / Timing

| Setting | Default | Description |
|---|---|---|
| Cooldown | 60 s | Minimum time between automatic generation triggers |
| Context messages | 5 | How many recent messages to send to the LLM for analysis |
| Crossfade | 3 s | Fade duration when switching tracks |
| ComfyUI URL | `http://127.0.0.1:8188` | Address of your ComfyUI instance |
| Start delay | 8 s | How long to wait after opening a chat before first generation |

---

## Workflow Template Variables

When writing a custom workflow JSON, use these placeholders — they are replaced at generation time:

| Variable | Description |
|---|---|
| `%prompt%` | The LLM-generated text description |
| `%negative_prompt%` | Negative prompt (empty by default) |
| `%seed%` | Random seed |
| `%steps%` | Sampler step count |
| `%cfg%` | CFG scale |
| `%duration%` | Clip duration in seconds |
| `%bpm%` | Beats per minute *(music only)* |
| `%keyscale%` | Key and scale, e.g. `A minor` *(music only)* |
| `%timesignature%` | Time signature numerator: `2`, `3`, `4`, or `6` *(music only)* |
| `%lyrics%` | Lyrics string — always empty, reserved for future use *(music only)* |
| `%unet_name%` | UNET model filename *(music only — required in custom music workflows)* |

---

## Music Presets

Presets save the current combination of **UNET model**, **duration**, **steps**, and **CFG** under a name for quick recall.

- **💾 Save** — prompts for a name and saves the current values
- **📂 Load** — applies the selected preset to the settings fields
- **🗑 Delete** — removes the selected preset after confirmation

---

## Audio Library

The library stores all generated tracks on disk, organised by chat/group. Open it with **📚 Library**.

- Switch between **Music**, **Ambient**, and **All Chats** tabs
- Play (▶), download (💾), or delete (✕) individual tracks
- Delete all tracks for a specific chat with 🗑 per-chat
- **Delete All Tracks** removes every saved file across all chats

---

## How It Works

```
New message received
        ↓
LLM analyses recent chat text
        ↓
Returns JSON: { ambient: { changed, prompt }, music: { changed, prompt, bpm, keyscale, timesig } }
        ↓
If changed → queue generation job in ComfyUI
        ↓
Poll /history until completed
        ↓
Crossfade new audio into the active channel
        ↓
Save track to library (if enabled)
```

Generation requests are serialised through an internal queue — only one ComfyUI job runs at a time, and the plugin waits for the queue to be free before submitting.

---

## Troubleshooting

**No audio is generated**
- Check that ComfyUI is running and the URL is correct (use the 🧪 Test button)
- Verify that the required model files are present in ComfyUI's model directories
- Open your browser console and look for `[AutoMusic]` log lines

**"No UNETLoader info found" after clicking 🔄**
- Make sure the ACE Step custom nodes are installed in ComfyUI (`TextEncodeAceStepAudio1.5`, `EmptyAceStep1.5LatentAudio`, `UNETLoader`)

**Music generates but sounds wrong**
- Try enabling **LLM picks BPM / key / time sig** for more contextually appropriate parameters
- Increase **Steps** (try 20–30) for higher quality at the cost of generation time

**Tracks disappear after page reload**
- Enable **Save to library** — without it, tracks are only kept for the current session

**ComfyUI workflow error**
- If you use a custom music workflow, make sure it contains `%unet_name%` as a placeholder — hardcoded model names will not be updated when you change the UNET model in settings

---

## Version History

| Version | Changes |
|---|---|
| 1.7.0 | UNET model selector UI, model list fetcher from ComfyUI, music presets |
| 1.6.0 | Per-chat audio library, auto-delete on chat removal, shuffle & auto-play |
| 1.5.x | ACE Step v1.5 support, LLM music parameter selection |
| 1.4.x | Crossfade engine, session gallery, mute/lock controls |
| 1.3.x | Queue system, cooldown, context message count setting |

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

*AutoMusic is a third-party extension and is not affiliated with SillyTavern.*
