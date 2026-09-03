// FILE: data/testimonials.ts
// Purpose: Canonical list of Synara testimonials sourced from X (Twitter) posts.
// Layer: Static data
// Notes: Each entry is keyed by its tweet id. The live tweet (author, avatar,
//        full text, likes, media) is fetched at render time via lib/tweets.ts —
//        mirroring the link-manager tweet pipeline — so the "Anonymous" / trimmed
//        rows from the original spreadsheet resolve to their real authors. The
//        fallback fields below keep the wall populated if a fetch ever fails.

export type TestimonialTier = 1 | 2 | 3;

export interface TestimonialSeed {
  /** Numeric X status id — the only thing react-tweet needs to resolve a post. */
  id: string;
  /** Curation tier (1 = strongest social proof). Drives ordering. */
  tier: TestimonialTier;
  /** Handle to show if the live tweet cannot be fetched. */
  fallbackHandle: string;
  /** Text to show if the live tweet cannot be fetched. */
  fallbackText: string;
  /** Permalink, used for the fallback "view on X" link. */
  fallbackUrl: string;
  /**
   * Optional English translation, shown (with a "Translated from …" label) in
   * place of the original. react-tweet returns only the original-language text,
   * so the translation is supplied here.
   */
  translation?: string;
  /** Source language code of the original tweet (e.g. "zh"), for the label. */
  translationLang?: string;
}

// Ordered strongest-first; the section renders them as a single masonry wall.
export const TESTIMONIALS: TestimonialSeed[] = [
  {
    id: "2065270654019264867",
    tier: 1,
    fallbackHandle: "LinearUncle",
    fallbackText:
      "Synara — a coding GUI whose interface closely resembles Codex. I tried it and it really is a lot like Codex, so there's no learning curve at all. A common setup in the Chinese dev community is pairing it with Deepseek; it supports 8 popular coding agents like Pi, Claude Code, and OpenCode. I tested it with Pi + Deepseek and it works great — there's even a kanban board mode.",
    fallbackUrl: "https://x.com/LinearUncle/status/2065270654019264867",
    translation:
      "Synara — a coding GUI whose interface closely resembles Codex. I tried it and it really is a lot like Codex, so there's no learning curve at all. A common setup in the Chinese dev community is pairing it with Deepseek; it supports 8 popular coding agents like Pi, Claude Code, and OpenCode. I tested it with Pi + Deepseek and it works great — there's even a kanban board mode.",
    translationLang: "zh",
  },
  {
    id: "2064189943237181849",
    tier: 1,
    fallbackHandle: "uzairansar",
    fallbackText:
      "Gotta say... WOW. @emanueledpt knocked it out of the park with this. Love being able to use Codex, Claude, Cursor, and OpenCode all within the same GUI.",
    fallbackUrl: "https://x.com/uzairansar/status/2064189943237181849",
  },
  {
    id: "2065233838498865624",
    tier: 1,
    fallbackHandle: "uzairansar",
    fallbackText: "The local server feature in @trySynara is lowkey goated",
    fallbackUrl: "https://x.com/uzairansar/status/2065233838498865624",
  },
  {
    id: "2065191018635329877",
    tier: 1,
    fallbackHandle: "maboroshidev",
    fallbackText: "first reaction 10/10 @trySynara @emanueledpt",
    fallbackUrl: "https://x.com/maboroshidev/status/2065191018635329877",
  },
  {
    id: "2065178684537888877",
    tier: 1,
    fallbackHandle: "domhfr",
    fallbackText:
      "Really disappointed with the speed of GPT-5.4-Mini in Codex when building swift code. Switched to Synara and Composer 2.5 and it's literally flying!!",
    fallbackUrl: "https://x.com/domhfr/status/2065178684537888877",
  },
  {
    id: "2066574154741027134",
    tier: 1,
    fallbackHandle: "alpes_aux_andes",
    fallbackText:
      "Why nobody is talking about @trySynara ?\nThis app is so well designed I can't believe it",
    fallbackUrl: "https://x.com/alpes_aux_andes/status/2066574154741027134",
  },
  {
    id: "2066644113508749678",
    tier: 1,
    fallbackHandle: "danfq_dev",
    fallbackText: "man i just CAN'T get enough of @trySynara\nit's just sooooo goooooooooooood",
    fallbackUrl: "https://x.com/danfq_dev/status/2066644113508749678",
  },
  {
    id: "2062730056082850270",
    tier: 2,
    fallbackHandle: "HugoAssis_",
    fallbackText:
      "I've been using @trySynara for a few hours now. I'm really impressed. I'd already tried T3 Chat, Orca, and Terax, but none of them managed to grab my attention quite like Synara did.",
    fallbackUrl: "https://x.com/HugoAssis_/status/2062730056082850270",
  },
  {
    id: "2066256453162385479",
    tier: 2,
    fallbackHandle: "sanjaydotpro",
    fallbackText:
      "@trySynara Use it almost daily, loving it so far, has almost become a part of my workflow. Founder here.",
    fallbackUrl: "https://x.com/sanjaydotpro/status/2066256453162385479",
  },
  {
    id: "2065408122768814220",
    tier: 2,
    fallbackHandle: "TxoriAGI",
    fallbackText:
      "I recommend @emanueledpt open sourced Synara app. Pretty good if you want something similar to codex but with claude :)",
    fallbackUrl: "https://x.com/TxoriAGI/status/2065408122768814220",
  },
  {
    id: "2064376772318154825",
    tier: 2,
    fallbackHandle: "HugoAssis_",
    fallbackText: "that's why we love synara.",
    fallbackUrl: "https://x.com/HugoAssis_/status/2064376772318154825",
  },
  {
    id: "2066131113979035883",
    tier: 3,
    fallbackHandle: "vkpdeveloper",
    fallbackText: "i love this feature, I think now i'll have to switch to synara no matter what",
    fallbackUrl: "https://x.com/vkpdeveloper/status/2066131113979035883",
  },
  {
    id: "2066183684026417180",
    tier: 3,
    fallbackHandle: "synara",
    fallbackText:
      "@trySynara's way of working with agents is exactly what I need. Of course, the design is also much better than AionUI. I knew about Synara before, but now I can finally use it since it has a Linux version.",
    fallbackUrl: "https://x.com/i/status/2066183684026417180",
  },
  {
    id: "2065500826240450668",
    tier: 3,
    fallbackHandle: "synara",
    fallbackText: "Wait this looks EXTREMELY clean. I'm downloading this rn",
    fallbackUrl: "https://x.com/i/status/2065500826240450668",
  },
  {
    id: "2064900969847300354",
    tier: 3,
    fallbackHandle: "synara",
    fallbackText: "Synara looking absolutely beautiful to work with now",
    fallbackUrl: "https://x.com/i/status/2064900969847300354",
  },
  {
    id: "2066108708266869096",
    tier: 3,
    fallbackHandle: "synara",
    fallbackText: "Synara keeps getting better",
    fallbackUrl: "https://x.com/i/status/2066108708266869096",
  },
];
