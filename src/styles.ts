export interface StylePreset {
  name: string;
  description: string;
  /** Stroke width as a fraction of font size. 0 disables the stroke layer. */
  strokeRatio: number;
  /** Share of the 720px frame the text block may occupy. */
  maxHeightRatio: number;
  /** Serifs lose their detail under all-caps at small sizes — opt in per style. */
  textCase: "upper" | "none";
  /** CSS appended to the base sheet. */
  css: string;
}

export const STYLES: Record<string, StylePreset> = {
  punch: {
    name: "punch",
    description: "Big outlined caps, hard shadow — the loud one",
    strokeRatio: 0.032,
    maxHeightRatio: 0.86,
    textCase: "upper",
    css: `
      .layer { justify-content: center; }
      .layer[data-zone="left"] .textbox, .layer[data-zone="right"] .textbox { width: 66%; }
      .headline { color: var(--fill); line-height: 0.98; }
      .headline .accent { color: var(--accent); }
      .headline.stroke { -webkit-text-stroke: var(--stroke-w) var(--stroke); }
      .headline.fill { filter: drop-shadow(0 calc(var(--stroke-w) * 1.1) 0 rgba(0,0,0,.5))
                               drop-shadow(0 2px 24px rgba(0,0,0,.45)); }
      .eyebrow { color: var(--accent); font-size: 26px; letter-spacing: .26em; margin-bottom: 20px;
                 text-shadow: 0 2px 6px rgba(0,0,0,.8); }
      .sub { color: var(--accent); font-size: 32px; letter-spacing: .04em; margin-top: 22px;
             text-shadow: 0 3px 8px rgba(0,0,0,.7); }
    `,
  },
  bar: {
    name: "bar",
    description: "Headline set into a solid accent bar across the bottom",
    strokeRatio: 0,
    maxHeightRatio: 0.44,
    textCase: "none",
    css: `
      .layer { justify-content: flex-end; padding: 0; }
      .textbox { width: 100%; background: var(--accent); padding: 28px 52px 32px;
                 box-shadow: 0 -8px 44px rgba(0,0,0,.5); }
      .headline { color: var(--bar-ink); line-height: 1.0; }
      .headline .accent { color: var(--fill); }
      .eyebrow .accent, .sub .accent { color: var(--fill); }
      .eyebrow { color: var(--bar-ink); opacity: .62; font-size: 23px; letter-spacing: .28em;
                 margin-bottom: 14px; }
      .sub { color: var(--bar-ink); opacity: .72; font-size: 27px; margin-top: 12px; }
    `,
  },
  scrim: {
    name: "scrim",
    description: "Gradient scrim behind the text half — editorial, the pairing at its best",
    strokeRatio: 0,
    maxHeightRatio: 0.74,
    textCase: "none",
    css: `
      .scrim { position: absolute; inset: 0; }
      .scrim[data-zone="left"] {
        background: linear-gradient(90deg, rgba(8,6,16,.95) 0%, rgba(8,6,16,.76) 44%, rgba(8,6,16,0) 74%); }
      .scrim[data-zone="right"] {
        background: linear-gradient(270deg, rgba(8,6,16,.95) 0%, rgba(8,6,16,.76) 44%, rgba(8,6,16,0) 74%); }
      .scrim[data-zone="bottom"], .scrim[data-zone="none"] {
        background: linear-gradient(0deg, rgba(8,6,16,.96) 0%, rgba(8,6,16,.62) 40%, rgba(8,6,16,0) 72%); }
      .layer { justify-content: center; }
      .headline { color: var(--fill); line-height: 1.02;
                  filter: drop-shadow(0 4px 20px rgba(0,0,0,.6)); }
      .headline .accent { color: var(--accent); }
      .eyebrow { color: var(--accent); font-size: 25px; letter-spacing: .26em; margin-bottom: 22px; }
      .sub { color: rgba(255,255,255,.68); font-size: 29px; margin-top: 26px; letter-spacing: .01em; }
    `,
  },
  outline: {
    name: "outline",
    description: "Caps with a thick accent outline, centered",
    strokeRatio: 0.048,
    maxHeightRatio: 0.72,
    textCase: "upper",
    css: `
      .layer { justify-content: center; align-items: center; text-align: center; }
      .textbox { align-items: center; }
      .headline { color: var(--fill); line-height: 0.98; }
      .headline .accent { color: var(--accent); }
      .headline.stroke { -webkit-text-stroke: var(--stroke-w) var(--accent); }
      .headline.fill { filter: drop-shadow(0 6px 20px rgba(0,0,0,.75)); }
      .eyebrow { color: var(--accent); font-size: 24px; letter-spacing: .3em; margin-bottom: 20px;
                 text-shadow: 0 2px 8px rgba(0,0,0,.85); }
      .sub { background: var(--accent); color: var(--bar-ink); font-size: 25px;
             letter-spacing: .12em; padding: 8px 20px; margin-top: 24px; }
    `,
  },
  chalk: {
    name: "chalk",
    description: "Centre-bottom headline, no stroke, soft shadow — for busy textured plates",
    strokeRatio: 0,
    maxHeightRatio: 0.5,
    textCase: "none",
    css: `
      .layer { justify-content: flex-end; align-items: center; text-align: center; padding-bottom: 10px; }
      .textbox { align-items: center; }
      .headline { color: var(--fill); line-height: 1.0;
                  filter: drop-shadow(0 3px 7px rgba(0,0,0,.6)) drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
      .headline .accent { color: var(--accent); }
      .eyebrow { color: var(--accent); font-size: 24px; letter-spacing: .3em; margin-bottom: 16px; }
      .sub { color: rgba(255,255,255,.72); font-size: 27px; margin-top: 18px; }
    `,
  },
};

export const DEFAULT_STYLE = "punch";
