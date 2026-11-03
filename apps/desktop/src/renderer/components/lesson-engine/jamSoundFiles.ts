// Where the Jam tab's recorded sounds (softer/*.wav) are served from
export const jamSoundUrl = (file: string): string => new URL(`./softer/${file}`, import.meta.url).href;
