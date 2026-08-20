# Cue audio

Each file here replaces one beat of the pick reveal. Swap any of them for your
own — **any format your browser can decode** works (`.mp3`, `.wav`, `.ogg`,
`.m4a`, …), and anything you delete falls back to the built-in synthesizer.

| Cue | Plays when | Suggested length |
| --- | --- | --- |
| `beam` | the light beam builds, before the position flashes | ~1s |
| `position` | the position card punches in | < 0.6s |
| `team` | the club card punches in | < 0.6s |
| `reveal` | the player card walks out (round 1 payoff) | 1.5–3s |
| `sting` | the round 2+ banner resolves | < 0.6s |
| `tick` | subtle mode | < 0.2s |

## Swapping a sound

1. Drop your file in here named after the cue — `reveal.mp3`, `position.wav`, …
2. In the app: **Setup → Sound source → Reload**. The panel lists what each cue
   resolved to, with a ▶ button to audition it.

Prefer different filenames? Point `manifest.json` at them, and set a per-cue
gain if one file is louder than the rest:

```json
{
  "reveal": "my-walkout-fanfare.mp3",
  "sting": { "file": "quick-blip.wav", "gain": 0.6 },
  "tick": null
}
```

`null` pins a cue to the synthesizer. Filenames must be plain names in this
folder — no paths or URLs — and the page's Content-Security-Policy only allows
media from this origin, so a manifest can't pull audio off the internet.

Cues are cut off when the next pick starts, so a long file won't bleed into the
following walkout.

## The placeholders

The files committed here are placeholders, synthesized from oscillators and
generated noise by `scripts/make-placeholder-audio.mjs` — original sound, no
licensed audio. Regenerate them with:

```bash
npm run audio                                # writes .wav (no dependencies)
npm i -D @breezystack/lamejs && npm run audio # writes .mp3 instead
```
