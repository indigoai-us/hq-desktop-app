# Accomplishments announcement sounds

Used by `../card-sounds.ts`. There are four takes per action, and the player picks one at random, never the same one twice in a row.

| Action | Files | Source |
| --- | --- | --- |
| intro | `intro-a` to `intro-d` | Google Lyria 3 Clip |
| deal | `deal-a`, `deal-b`, `deal-c`, `deal-d` | Google Veo 3.1 Lite foley |
| flip | `flip-a`, `flip-c` (Veo); `flip-b`, `flip-d` (Lyria) | Veo 3.1 Lite and Lyria 3 Clip |
| land | `land-a`, `land-c`, `land-d` (Veo); `land-b` (Lyria) | Veo 3.1 Lite and Lyria 3 Clip |
| hover | `hover-a` to `hover-d` | Google Lyria 3 Clip |
| dismiss | `dismiss-a`, `dismiss-c` (Veo); `dismiss-b`, `dismiss-d` (Lyria) | Veo 3.1 Lite and Lyria 3 Clip |

They were generated on 2026-10-15 through the Gemini API on Indigo's paid tier and trimmed to 0.2-0.8 s (intros 2.5-3.9 s). Each was mastered quiet at about -12 dBFS peak, as mono 96 kbps MP3.

Licensing, from the Gemini API Additional Terms: Google does not claim ownership of generated content, and it may generate similar content for others. All of these files carry Google's inaudible SynthID audio watermark. On the paid tier, prompts and outputs are not used to improve Google's products.

To regenerate or retrim them, the generator, analyser and cutter scripts live outside this repo, in the HQ workspace (`workspace/scratch/badges-sfx/`).
